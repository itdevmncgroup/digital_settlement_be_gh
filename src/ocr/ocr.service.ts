import { Injectable, Logger } from '@nestjs/common';
import { recognizeText } from '../common/ocr/recognize-text.util';

export interface ParsedReceiptItem {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface ParsedReceipt {
  rawText: string;
  confidence: number;
  merchantName: string | null;
  invoiceDate: string | null;
  items: ParsedReceiptItem[];
  subtotal: number | null;
  tax: number | null;
  serviceCharge: number | null;
  total: number | null;
  warnings: string[];
}

// Matches an IDR-style number: thousand-separator dots/commas, optional
// trailing ",00"/".00" cents which are dropped (receipts in the sample never
// carry real fractional Rupiah). e.g. "1.200.000" -> 1200000, "650.000" -> 650000.
function parseIdrNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(/[^\d.,]/g, '');
  if (!cleaned) return null;
  const digitsOnly = cleaned.replace(/[.,]/g, '');
  const n = Number(digitsOnly);
  return Number.isFinite(n) ? n : null;
}

const TRAILING_NUMBER = /([\d][\d.,]*)\s*$/;
// A currency-marked amount ("Rp.940,800", "IDR 940800") is a much stronger
// signal than a bare trailing number - EDC/credit-card slips print other
// codes (APPR.CODE, TRACE NO, BATCH) on the same printed row as TOTAL due to
// their narrow two-column layout, so a bare number can't be trusted there.
const RP_AMOUNT_RE = /(?:rp\.?|idr)\s*([\d][\d.,]*)/i;

const SUBTOTAL_RE = /sub[\s-]*total/i;
const TAX_RE = /(ppn|pajak|tax)/i;
const SERVICE_CHARGE_RE = /(service\s*charge|biaya\s*layanan|order\s*fee)/i;
const TOTAL_RE = /^\s*(grand\s*total|total)\b/i;

// EDC/credit-card slips (BCA, Mandiri, BNI, ...) print the bank's own name as
// the first line, with the actual merchant name on the line right after it -
// unlike a merchant's own thermal receipt, where line 1 already IS the
// merchant name. Not anchored to line-start: low-res phone-camera shots often
// OCR a stray leading glyph onto that line (e.g. ". «BCA"), which would
// otherwise defeat a `^`-anchored match.
const BANK_HEADER_RE = /\b(bca|bri|bni|mandiri|cimb\s*niaga|danamon|permata|ocbc|panin|maybank|uob|hsbc|btn|bukopin|mega|commonwealth|sinarmas|btpn)\b/i;

// Given a label line's index, find the amount attached to it: same line
// first, then up to 2 lines below (an EDC slip often prints the label and its
// value on separate rows, e.g. "TOTAL" then "/ Rp.940,800"). A Rp/IDR-marked
// amount anywhere in that window always wins over a bare trailing number.
function findAmountNear(lines: string[], index: number): number | null {
  const window = [index, index + 1, index + 2].filter((i) => i < lines.length);
  for (const i of window) {
    const rpMatch = lines[i].match(RP_AMOUNT_RE);
    if (rpMatch) {
      const v = parseIdrNumber(rpMatch[1]);
      if (v !== null) return v;
    }
  }
  for (const i of window) {
    const trailing = lines[i].match(TRAILING_NUMBER);
    if (trailing) {
      const v = parseIdrNumber(trailing[1]);
      if (v !== null) return v;
    }
  }
  return null;
}

// Transaction date - tried in order: ISO (2026-09-07), slash/dash D-M-Y or
// Y-M-D (07/09/2026, 7-9-26), then "7 Sep 2026" / "13 MAY,26" with an
// Indonesian or English month name (comma before the year is an EDC-slip
// "DATE/TIME" quirk, e.g. BCA's "13 MAY,26 10:19"). A line carrying an
// explicit "tanggal"/"tgl"/"date" label is preferred over a bare date found
// anywhere else on the receipt (e.g. inside a transaction/reference number).
const DATE_LABEL_RE = /(tanggal|tgl|date)\s*[:\-]?/i;
const ISO_DATE_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/;
const SLASH_DASH_DATE_RE = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/;
const MONTH_NAME_DATE_RE = /\b(\d{1,2})\s+([a-zA-Z]{3,9}),?\s*(\d{2,4})\b/;
const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7,
  agu: 8, ags: 8, aug: 8, sep: 9, sept: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12,
};

function toIsoDate(year: number, month: number, day: number): string | null {
  const fullYear = year < 100 ? 2000 + year : year;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(fullYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Receipts are day-first (DD/MM/YYYY), the Indonesian convention, unlike the
// ISO and month-name forms which are unambiguous.
function parseDateFromLine(line: string): string | null {
  let m = line.match(ISO_DATE_RE);
  if (m) return toIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));

  m = line.match(SLASH_DASH_DATE_RE);
  if (m) return toIsoDate(Number(m[3]), Number(m[2]), Number(m[1]));

  m = line.match(MONTH_NAME_DATE_RE);
  if (m) {
    const month = MONTH_NAMES[m[2].toLowerCase().slice(0, 4)] ?? MONTH_NAMES[m[2].toLowerCase().slice(0, 3)];
    if (month) return toIsoDate(Number(m[3]), month, Number(m[1]));
  }
  return null;
}

// Pattern A: "Item Name  2x @50.000  100.000" (single line, qty/unit-price/line-total together).
const ITEM_LINE_SINGLE = /^(.+?)\s+(\d+)\s*x\s*@?\s*([\d.,]+)\s+([\d.,]+)\s*$/i;
// Pattern B: "1x @650.000  650.000" (qty/price/total only, no leading name - name was the previous line).
const ITEM_LINE_QTY_ONLY = /^(\d+)\s*x\s*@?\s*([\d.,]+)(?:\s+([\d.,]+))?\s*$/i;

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);

  // Best-effort receipt scan: extracts merchant/items/totals for the caller to
  // pre-fill an editable form. Never throws for a low-quality image - returns
  // whatever could be parsed plus `warnings`, since OCR on thermal receipts is
  // inherently imperfect and the result is always user-reviewed before saving.
  async scan(buffer: Buffer): Promise<ParsedReceipt> {
    const { text, confidence } = await recognizeText(buffer);
    this.logger.debug(`OCR confidence: ${confidence}`);
    return this.parseReceiptText(text, confidence);
  }

  parseReceiptText(rawText: string, confidence = 0): ParsedReceipt {
    const lines = rawText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const warnings: string[] = [];
    // On an EDC/credit-card slip, one of the first few lines is the issuing
    // bank's own name, not the merchant - the merchant name is printed right
    // below it instead. Scanned within the first 3 lines only (rather than
    // anywhere in the receipt) so an unrelated later mention of a bank name
    // can't hijack merchant detection.
    const bankHeaderIndex = lines.slice(0, 3).findIndex((line) => BANK_HEADER_RE.test(line));
    let merchantName = bankHeaderIndex >= 0 ? (lines[bankHeaderIndex + 1] ?? lines[0] ?? null) : (lines[0] ?? null);

    // Prefer a line explicitly labeled as the date (avoids picking up an
    // unrelated number, e.g. inside a transaction/reference ID) - only fall
    // back to the first bare date found anywhere if no labeled line matches.
    let invoiceDate: string | null = null;
    for (const line of lines) {
      if (DATE_LABEL_RE.test(line)) {
        const parsed = parseDateFromLine(line);
        if (parsed) {
          invoiceDate = parsed;
          break;
        }
      }
    }
    if (!invoiceDate) {
      for (const line of lines) {
        const parsed = parseDateFromLine(line);
        if (parsed) {
          invoiceDate = parsed;
          break;
        }
      }
    }
    if (!invoiceDate) {
      warnings.push('Could not detect a transaction date - please enter it manually.');
    }

    let subtotal: number | null = null;
    let tax: number | null = null;
    let serviceCharge: number | null = null;
    let total: number | null = null;
    let totalsStartIndex = lines.length;

    lines.forEach((line, i) => {
      if (SUBTOTAL_RE.test(line)) {
        const value = findAmountNear(lines, i);
        if (value !== null) {
          subtotal = value;
          totalsStartIndex = Math.min(totalsStartIndex, i);
        }
      } else if (SERVICE_CHARGE_RE.test(line)) {
        const value = findAmountNear(lines, i);
        if (value !== null) {
          serviceCharge = value;
          totalsStartIndex = Math.min(totalsStartIndex, i);
        }
      } else if (TAX_RE.test(line)) {
        const value = findAmountNear(lines, i);
        if (value !== null) {
          tax = value;
          totalsStartIndex = Math.min(totalsStartIndex, i);
        }
      } else if (TOTAL_RE.test(line)) {
        const value = findAmountNear(lines, i);
        if (value !== null) {
          total = value;
          totalsStartIndex = Math.min(totalsStartIndex, i);
        }
      }
    });

    const items: ParsedReceiptItem[] = [];
    const itemLines = lines.slice(1, totalsStartIndex);
    for (let i = 0; i < itemLines.length; i++) {
      const line = itemLines[i];

      const singleMatch = line.match(ITEM_LINE_SINGLE);
      if (singleMatch) {
        const [, name, qty, unitPrice, lineTotal] = singleMatch;
        const q = Number(qty);
        const up = parseIdrNumber(unitPrice);
        const lt = parseIdrNumber(lineTotal);
        if (up !== null && lt !== null) {
          items.push({ description: name.trim(), quantity: q, unitPrice: up, lineTotal: lt });
          continue;
        }
      }

      const qtyOnlyMatch = line.match(ITEM_LINE_QTY_ONLY);
      if (qtyOnlyMatch && i > 0) {
        const [, qty, unitPrice, lineTotal] = qtyOnlyMatch;
        const q = Number(qty);
        const up = parseIdrNumber(unitPrice);
        const lt = lineTotal ? parseIdrNumber(lineTotal) : up !== null ? up * q : null;
        if (up !== null && lt !== null) {
          const prevItem = items[items.length - 1];
          // Two-line form: previous line was the item name with no numbers of its own.
          if (prevItem && prevItem.quantity === 1 && prevItem.unitPrice === 0) {
            prevItem.quantity = q;
            prevItem.unitPrice = up;
            prevItem.lineTotal = lt;
            continue;
          }
        }
      }

      // Fallback: a bare name-only line just before a qty line becomes a
      // zero-priced placeholder that the qty-only branch above fills in next iteration.
      if (!TRAILING_NUMBER.test(line) || !parseIdrNumber(line.match(TRAILING_NUMBER)?.[1] ?? '')) {
        items.push({ description: line, quantity: 1, unitPrice: 0, lineTotal: 0 });
      }
    }
    // Drop any placeholder that never got filled in by a following qty line (noise, dashes, etc).
    const resolvedItems = items.filter((it) => it.lineTotal > 0);

    if (subtotal !== null && resolvedItems.length > 0) {
      const itemsSum = resolvedItems.reduce((sum, it) => sum + it.lineTotal, 0);
      if (Math.abs(itemsSum - subtotal) > 1) {
        warnings.push(`Sum of items (${itemsSum}) does not match parsed subtotal (${subtotal}) - please review.`);
      }
    }

    return { rawText, confidence, merchantName, invoiceDate, items: resolvedItems, subtotal, tax, serviceCharge, total, warnings };
  }
}
