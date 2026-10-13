import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { renderPdfPages, streamPdfPagesToImages } from '../bank-matching/pdf-to-images.util';

// Every page of the output PDF is A4 landscape.
const A4_LANDSCAPE: [number, number] = [841.89, 595.28];
const MARGIN = 30;
const TZ = 'Asia/Jakarta';
const MAX_INVOICE_PDF_PAGES = 3;
// A user-uploaded statement is included in full, so an oversized one is rejected
// rather than silently truncated.
const MAX_UPLOADED_STATEMENT_PAGES = 50;

const BLUE = rgb(0x44 / 255, 0x72 / 255, 0xc4 / 255);
const BLACK = rgb(0, 0, 0);
const GRID = rgb(0.55, 0.55, 0.55);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

interface PreparedImage {
  jpeg: Buffer;
  width: number;
  height: number;
  caption: string;
}

interface TableColumn {
  width: number;
  align?: 'left' | 'center' | 'right';
}

const expenseSelect = {
  id: true,
  expenseNo: true,
  expenseDate: true,
  purpose: true,
  amount: true,
  merchantName: true,
  location: true,
  paymentMethod: { select: { code: true } },
  advertiser: { select: { name: true } },
  participants: {
    select: {
      category: true,
      name: true,
      position: true,
      company: true,
      agency: { select: { name: true } },
      advertiser: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  photos: {
    select: { id: true, storageKey: true, fileName: true, mimeType: true },
    orderBy: { createdAt: 'asc' as const },
  },
  invoices: {
    select: {
      invoiceNumber: true,
      finalMerchantName: true,
      merchant: { select: { name: true } },
      files: {
        select: { id: true, fileType: true, storageKey: true, fileName: true, mimeType: true },
        orderBy: { createdAt: 'asc' as const },
      },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.ExpenseSelect;

type ExpenseRow = Awaited<ReturnType<SettlementPdfService['loadSettlement']>>['expenses'][number];

// pdf-lib's standard fonts only encode WinAnsi; anything else would throw.
const safe = (s: string | null | undefined) => (s ?? '').replace(/[^\x20-\x7E -ÿ]/g, '?');
const formatRupiah = (n: number) => `Rp ${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(n)}`;
const formatLongDate = (d: Date) =>
  d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: TZ });
const formatDateTime = (d: Date) => d.toLocaleString('sv-SE', { timeZone: TZ });

// "Create Draft PR" attachment: Form Jamuan table + approval log, then the bank
// statement pages (every page of the statement the user uploaded - none when no
// statement was uploaded), then one page of activity photos / invoice images per
// Expense.
@Injectable()
export class SettlementPdfService {
  private readonly logger = new Logger(SettlementPdfService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async build(settlementId: string, uploadedStatement?: Buffer): Promise<{ buffer: Buffer; fileName: string }> {
    const settlement = await this.loadSettlement(settlementId);
    const pdf = await PDFDocument.create();
    const fonts: Fonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };

    this.drawFormJamuan(pdf, fonts, settlement);
    // No statement picked in the popup -> no bank statement pages at all.
    if (uploadedStatement) await this.addUploadedStatementPages(pdf, fonts, uploadedStatement);
    for (const expense of settlement.expenses) {
      await this.addExpenseImagePage(pdf, fonts, expense);
    }

    const bytes = await pdf.save();
    return { buffer: Buffer.from(bytes), fileName: `${settlement.settlementNo}.pdf` };
  }

  async loadSettlement(id: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      select: {
        id: true,
        settlementNo: true,
        status: true,
        createdAt: true,
        department: { select: { name: true } },
        createdBy: { select: { name: true } },
        approvalRequest: {
          select: {
            steps: {
              select: {
                stepOrder: true,
                status: true,
                submittedAt: true,
                submittedBy: { select: { name: true } },
                position: { select: { name: true } },
                resolvedApprover: { select: { name: true } },
              },
              orderBy: { stepOrder: 'asc' },
            },
          },
        },
        expenses: { select: expenseSelect, orderBy: [{ expenseDate: 'asc' }, { expenseNo: 'asc' }] },
      },
    });
    if (!settlement) throw new NotFoundException('Settlement not found');
    return settlement;
  }

  // ---------------------------------------------------------------------------
  // Page 1+: Form Jamuan table (same columns as sheet "Form Jamuan") + approval log
  // ---------------------------------------------------------------------------

  private drawFormJamuan(pdf: PDFDocument, fonts: Fonts, settlement: Awaited<ReturnType<SettlementPdfService['loadSettlement']>>) {
    const ph = A4_LANDSCAPE[1];
    // `cur` is the drawing cursor: current page + y of the next free edge (top-down).
    const cur = { page: pdf.addPage(A4_LANDSCAPE), y: ph - MARGIN };
    const newPage = () => {
      cur.page = pdf.addPage(A4_LANDSCAPE);
      cur.y = ph - MARGIN;
    };

    cur.page.drawText('Form Jamuan', { x: MARGIN, y: cur.y - 14, size: 16, font: fonts.bold, color: BLACK });
    cur.y -= 22;
    cur.page.drawText(safe(`${settlement.settlementNo}  |  ${settlement.department.name}`), { x: MARGIN, y: cur.y - 10, size: 9, font: fonts.regular, color: BLACK });
    cur.y -= 22;

    const cols: TableColumn[] = [
      { width: 24, align: 'center' }, // No
      { width: 78 }, // Tanggal
      { width: 70 }, // Venue
      { width: 34, align: 'center' }, // In/Out
      { width: 88 }, // Perusahaan/Instansi
      { width: 88 }, // Yang Dijamu - Nama
      { width: 76 }, // Jabatan
      { width: 36, align: 'center' }, // Jumlah
      { width: 88 }, // Peserta Internal - Nama
      { width: 36, align: 'center' }, // Jumlah
      { width: 70, align: 'right' }, // Total
      { width: 94 }, // Keterangan
    ];
    const xs = cols.reduce<number[]>((acc, c, i) => [...acc, acc[i] + c.width], [MARGIN]);
    const tableWidth = xs[xs.length - 1] - MARGIN;
    const headerH = 16;

    const drawHeader = () => {
      const top = cur.y;
      const spans: { from: number; to: number; row: 0 | 1 | 'both'; label: string }[] = [
        { from: 0, to: 0, row: 'both', label: 'No.' },
        { from: 1, to: 1, row: 'both', label: 'Tanggal' },
        { from: 2, to: 3, row: 0, label: 'Lokasi Jamuan' },
        { from: 4, to: 4, row: 'both', label: 'Perusahaan / Instansi' },
        { from: 5, to: 7, row: 0, label: 'Yang Dijamu' },
        { from: 8, to: 9, row: 0, label: 'Peserta Internal' },
        { from: 10, to: 10, row: 'both', label: 'Total Biaya Jamuan (Rp)' },
        { from: 11, to: 11, row: 'both', label: 'Keterangan' },
        { from: 2, to: 2, row: 1, label: 'Venue' },
        { from: 3, to: 3, row: 1, label: 'In/Out' },
        { from: 5, to: 5, row: 1, label: 'Nama' },
        { from: 6, to: 6, row: 1, label: 'Jabatan' },
        { from: 7, to: 7, row: 1, label: 'Jumlah' },
        { from: 8, to: 8, row: 1, label: 'Nama' },
        { from: 9, to: 9, row: 1, label: 'Jumlah' },
      ];
      for (const s of spans) {
        const x = xs[s.from];
        const w = xs[s.to + 1] - x;
        const h = s.row === 'both' ? headerH * 2 : headerH;
        const cellTop = s.row === 1 ? top - headerH : top;
        cur.page.drawRectangle({ x, y: cellTop - h, width: w, height: h, color: BLUE, borderColor: GRID, borderWidth: 0.5 });
        const lines = this.wrap(s.label, fonts.bold, 7.5, w - 6);
        const blockH = lines.length * 9;
        lines.forEach((line, i) => {
          const tw = fonts.bold.widthOfTextAtSize(line, 7.5);
          cur.page.drawText(line, { x: x + (w - tw) / 2, y: cellTop - (h - blockH) / 2 - 7.5 - i * 9 + 1, size: 7.5, font: fonts.bold, color: rgb(1, 1, 1) });
        });
      }
      cur.y = top - headerH * 2;
    };

    drawHeader();

    let total = 0;
    settlement.expenses.forEach((e, idx) => {
      const external = e.participants.filter((p) => p.category !== 'EMPLOYEE');
      const internal = e.participants.filter((p) => p.category === 'EMPLOYEE');
      const companies = [...new Set(external.map((p) => p.company ?? p.agency?.name ?? p.advertiser?.name).filter((v): v is string => !!v))];
      const invoice = e.invoices[0];
      const amount = Number(e.amount);
      total += amount;
      this.drawRow(
        cur,
        fonts,
        cols,
        xs,
        [
          String(idx + 1),
          formatLongDate(e.expenseDate),
          e.merchantName ?? invoice?.finalMerchantName ?? invoice?.merchant?.name ?? e.location ?? '-',
          'Out', // no In/Out field on Expense - always Out
          (companies.length ? companies : [e.advertiser?.name ?? '-']).join(', '),
          external.map((p) => p.name).join(', ') || '-',
          external.map((p) => p.position ?? '-').join(', ') || '-',
          String(external.length),
          internal.map((p) => p.name).join(', ') || '-',
          String(internal.length),
          new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(amount),
          e.purpose,
        ],
        () => {
          newPage();
          drawHeader();
        },
      );
    });

    // TOTAL row
    const totalH = 18;
    if (cur.y - totalH < MARGIN) {
      newPage();
      drawHeader();
    }
    cur.page.drawRectangle({ x: MARGIN, y: cur.y - totalH, width: tableWidth, height: totalH, borderColor: GRID, borderWidth: 0.5, color: rgb(0.93, 0.93, 0.93) });
    cur.page.drawText('TOTAL', { x: MARGIN + 6, y: cur.y - 12, size: 8.5, font: fonts.bold, color: BLACK });
    const totalText = formatRupiah(total);
    cur.page.drawText(totalText, {
      x: xs[11] - 4 - fonts.bold.widthOfTextAtSize(totalText, 8.5),
      y: cur.y - 12,
      size: 8.5,
      font: fonts.bold,
      color: BLACK,
    });
    const isCard = settlement.expenses.length > 0 && settlement.expenses.every((e) => e.paymentMethod?.code === 'CORPORATE_CARD');
    cur.page.drawText(isCard ? 'CC' : 'Non-CC', { x: xs[11] + 4, y: cur.y - 12, size: 9, font: fonts.bold, color: BLACK });
    cur.y -= totalH + 24;

    // Log Approval Dokumen
    const logRows = this.buildApprovalLog(settlement);
    const logCols: TableColumn[] = [{ width: 30, align: 'center' }, { width: 170 }, { width: 330 }, { width: 120 }];
    const logXs = logCols.reduce<number[]>((acc, c, i) => [...acc, acc[i] + c.width], [MARGIN]);
    if (cur.y - 60 < MARGIN) newPage();
    cur.page.drawText('Log Approval Dokumen', { x: MARGIN, y: cur.y - 11, size: 11, font: fonts.bold, color: BLACK });
    cur.y -= 20;
    const drawLogHeader = () => {
      cur.page.drawRectangle({ x: MARGIN, y: cur.y - headerH, width: logXs[4] - MARGIN, height: headerH, color: BLUE, borderColor: GRID, borderWidth: 0.5 });
      ['NO', 'Approved By System', 'Action', 'Date Time'].forEach((label, i) => {
        cur.page.drawText(label, { x: logXs[i] + 5, y: cur.y - 11, size: 8, font: fonts.bold, color: rgb(1, 1, 1) });
      });
      cur.y -= headerH;
    };
    drawLogHeader();
    logRows.forEach((row, idx) => {
      this.drawRow(cur, fonts, logCols, logXs, [String(idx + 1), ...row], () => {
        newPage();
        drawLogHeader();
      });
    });
  }

  // The approvers who pressed Submit for their tier of the Settlement's own chain
  // (e.g. sales.bod -> vp -> co.cfo), in tier order, with ApprovalRequestStep.submittedAt
  // as the time. A tier that is not submitted (pending, or reopened by a revise) is left out.
  private buildApprovalLog(settlement: Awaited<ReturnType<SettlementPdfService['loadSettlement']>>): string[][] {
    const submitted = (settlement.approvalRequest?.steps ?? []).filter((st) => st.status === 'APPROVED' && st.submittedAt);
    return submitted.map((st, i) => [
      (st.submittedBy ?? st.resolvedApprover).name,
      `Proses Approval Level ${i + 1} (${st.position.name})${i === submitted.length - 1 && settlement.status === 'COMPLETE' ? ' - Final Approved' : ''}`,
      formatDateTime(st.submittedAt!),
    ]);
  }

  // Draws one table row at the cursor and advances it; `onNewPage` runs after the
  // cursor moved to a fresh page (to redraw the table header) when the row doesn't fit.
  private drawRow(
    cur: { page: PDFPage; y: number },
    fonts: Fonts,
    cols: TableColumn[],
    xs: number[],
    values: string[],
    onNewPage: () => void,
  ) {
    const size = 7.5;
    const lineH = 9.5;
    const wrapped = values.map((v, i) => this.wrap(safe(v), fonts.regular, size, cols[i].width - 8));
    const rowH = Math.max(...wrapped.map((l) => l.length)) * lineH + 8;
    if (cur.y - rowH < MARGIN) onNewPage();
    wrapped.forEach((lines, i) => {
      const x = xs[i];
      cur.page.drawRectangle({ x, y: cur.y - rowH, width: cols[i].width, height: rowH, borderColor: GRID, borderWidth: 0.5 });
      lines.forEach((line, li) => {
        const tw = fonts.regular.widthOfTextAtSize(line, size);
        const tx = cols[i].align === 'center' ? x + (cols[i].width - tw) / 2 : cols[i].align === 'right' ? x + cols[i].width - 4 - tw : x + 4;
        cur.page.drawText(line, { x: tx, y: cur.y - 4 - size - li * lineH + 1, size, font: fonts.regular, color: BLACK });
      });
    });
    cur.y -= rowH;
  }

  private wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const out: string[] = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        let w = word;
        // A single token wider than the cell (long id/URL) is hard-split.
        while (font.widthOfTextAtSize(w, size) > maxWidth && w.length > 1) {
          let cut = w.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxWidth) cut--;
          if (line) {
            out.push(line);
            line = '';
          }
          out.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        const candidate = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
        else {
          out.push(line);
          line = w;
        }
      }
      out.push(line);
    }
    return out.length ? out : [''];
  }

  // ---------------------------------------------------------------------------
  // Bank statement pages (only the statement uploaded in the popup)
  // ---------------------------------------------------------------------------

  // The statement PDF picked in the Create Draft PR popup: every page becomes an
  // image page right after the Form Jamuan pages. Pages are rendered one at a time
  // (a rendered page is large) and a bad file fails the request.
  private async addUploadedStatementPages(pdf: PDFDocument, fonts: Fonts, buffer: Buffer) {
    if (buffer.subarray(0, 4).toString() !== '%PDF') throw new BadRequestException('Bank statement must be a PDF file');
    let total: number;
    try {
      total = (await PDFDocument.load(buffer, { ignoreEncryption: true })).getPageCount();
    } catch {
      throw new BadRequestException('Bank statement PDF could not be read');
    }
    if (total > MAX_UPLOADED_STATEMENT_PAGES) {
      throw new BadRequestException(`Bank statement has ${total} pages - the maximum is ${MAX_UPLOADED_STATEMENT_PAGES}`);
    }

    let pageNo = 0;
    for await (const png of streamPdfPagesToImages(buffer, 2)) {
      pageNo++;
      const { data, info } = await sharp(png).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
      await this.drawImagePage(pdf, fonts, [{ jpeg: data, width: info.width, height: info.height, caption: '' }], `Bank statement - page ${pageNo} of ${total}`);
    }
  }

  // ---------------------------------------------------------------------------
  // One page per Expense: activity photos + invoice images, scaled to fit
  // ---------------------------------------------------------------------------

  private async addExpenseImagePage(pdf: PDFDocument, fonts: Fonts, expense: ExpenseRow) {
    const images: PreparedImage[] = [];

    for (const [i, photo] of expense.photos.entries()) {
      const prepared = await this.prepareImage(photo.storageKey, photo.mimeType, `Foto Kegiatan ${i + 1}`);
      images.push(...prepared);
    }

    for (const [invIdx, invoice] of expense.invoices.entries()) {
      // ORIGINAL is the uploaded scan/photo; PROCESSED is a derived copy of it.
      const original = invoice.files.filter((f) => f.fileType === 'ORIGINAL');
      const files = original.length ? original : invoice.files;
      for (const file of files) {
        const label = `Invoice${expense.invoices.length > 1 ? ` ${invIdx + 1}` : ''}${invoice.invoiceNumber ? ` - ${invoice.invoiceNumber}` : ''}`;
        images.push(...(await this.prepareImage(file.storageKey, file.mimeType, label)));
      }
    }

    if (images.length === 0) return;
    const venue = expense.merchantName ?? expense.invoices[0]?.finalMerchantName ?? expense.invoices[0]?.merchant?.name ?? expense.location ?? '-';
    await this.drawImagePage(pdf, fonts, images, `${expense.expenseNo}  |  ${formatLongDate(expense.expenseDate)}  |  ${venue}  |  ${formatRupiah(Number(expense.amount))}`, expense.purpose);
  }

  // Normalises any supported upload to JPEG; a PDF invoice contributes its first pages.
  private async prepareImage(storageKey: string, mimeType: string, caption: string): Promise<PreparedImage[]> {
    try {
      const buffer = await this.storage.read(storageKey);
      const isPdf = mimeType === 'application/pdf' || buffer.subarray(0, 4).toString() === '%PDF';
      const sources: { buffer: Buffer; caption: string }[] = [];
      if (isPdf) {
        const total = (await PDFDocument.load(buffer, { ignoreEncryption: true })).getPageCount();
        const pageNos = Array.from({ length: Math.min(total, MAX_INVOICE_PDF_PAGES) }, (_, i) => i + 1);
        const rendered = await renderPdfPages(buffer, pageNos, 2);
        for (const n of pageNos) {
          const png = rendered.get(n);
          if (png) sources.push({ buffer: png, caption: total > 1 ? `${caption} (p.${n})` : caption });
        }
      } else if (mimeType.startsWith('image/')) {
        sources.push({ buffer, caption });
      }

      const out: PreparedImage[] = [];
      for (const src of sources) {
        const { data, info } = await sharp(src.buffer)
          .rotate()
          .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 80 })
          .toBuffer({ resolveWithObject: true });
        out.push({ jpeg: data, width: info.width, height: info.height, caption: src.caption });
      }
      return out;
    } catch (err) {
      this.logger.warn(`Skipping image ${storageKey}: ${(err as Error).message}`);
      return [];
    }
  }

  // Adds a landscape page with a title and every image shrunk into an
  // equal-sized grid cell so all of them land on this single page.
  private async drawImagePage(pdf: PDFDocument, fonts: Fonts, images: PreparedImage[], title: string, subtitle?: string) {
    const headerH = subtitle ? 34 : 20;
    const gap = 10;
    const captionH = 11;

    const [pw, ph] = A4_LANDSCAPE;
    const areaW = pw - MARGIN * 2;
    const areaH = ph - MARGIN * 2 - headerH;
    let layout: { cols: number; rows: number; score: number; areaW: number; areaH: number } | null = null;
    for (let cols = 1; cols <= images.length; cols++) {
      const rows = Math.ceil(images.length / cols);
      const cellW = (areaW - gap * (cols - 1)) / cols;
      const cellH = (areaH - gap * (rows - 1)) / rows;
      const score = images.reduce((sum, img) => {
        const hasCaption = img.caption ? captionH : 0;
        const s = Math.min(cellW / img.width, (cellH - hasCaption) / img.height);
        return sum + s * s * img.width * img.height;
      }, 0);
      if (!layout || score > layout.score) layout = { cols, rows, score, areaW, areaH };
    }
    if (!layout) return;
    const page = pdf.addPage(A4_LANDSCAPE);

    page.drawText(safe(title).slice(0, 150), { x: MARGIN, y: ph - MARGIN - 9, size: 9, font: fonts.bold, color: BLACK });
    if (subtitle) {
      const line = this.wrap(safe(subtitle), fonts.regular, 8.5, pw - MARGIN * 2)[0];
      page.drawText(line, { x: MARGIN, y: ph - MARGIN - 23, size: 8.5, font: fonts.regular, color: BLACK });
    }

    const cellW = (layout.areaW - gap * (layout.cols - 1)) / layout.cols;
    const cellH = (layout.areaH - gap * (layout.rows - 1)) / layout.rows;
    const gridTop = ph - MARGIN - headerH;

    for (const [i, img] of images.entries()) {
      const col = i % layout.cols;
      const row = Math.floor(i / layout.cols);
      const cellX = MARGIN + col * (cellW + gap);
      const cellTop = gridTop - row * (cellH + gap);
      const hasCaption = img.caption ? captionH : 0;
      const scale = Math.min(cellW / img.width, (cellH - hasCaption) / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      if (img.caption) {
        // Clip to the cell so neighbouring captions never run into each other.
        let caption = safe(img.caption);
        while (caption.length > 1 && fonts.bold.widthOfTextAtSize(caption, 7.5) > cellW) caption = caption.slice(0, -2) + '.';
        page.drawText(caption, { x: cellX, y: cellTop - 8, size: 7.5, font: fonts.bold, color: BLACK });
      }
      const embedded = await pdf.embedJpg(img.jpeg);
      page.drawImage(embedded, { x: cellX + (cellW - w) / 2, y: cellTop - hasCaption - h - (cellH - hasCaption - h) / 2, width: w, height: h });
    }
  }
}
