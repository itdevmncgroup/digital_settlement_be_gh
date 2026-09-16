// Generic bank/credit-card settlement PDF parser (no fixed bank format on file yet -
// BRD section 18/AutoMatching). Extracts plain text via pdfjs-dist when the PDF has
// a real text layer, or via Tesseract OCR (same engine as receipt-photo OCR) when
// it doesn't - many banks' statements are actually a scanned/rasterized image per
// page (e.g. "print to PDF" via Ghostscript) with no text layer to extract at all.
// Either way, transactions are read one per line: a leading date, a trailing
// amount, description in between. Deliberately tolerant of DD/MM/YYYY, DD-MM-YYYY
// and YYYY-MM-DD dates, and both Indonesian (1.234.567,89) and plain (1234567.89)
// amount formats.
//
// Text extraction goes through pdfjs-dist (extractPdfText), not the `pdf-parse`
// package - pdf-parse's bundled old pdf.js gets corrupted by exceljs being loaded
// anywhere in the same process (Import module), throwing "Invalid PDF structure"
// on perfectly valid PDFs. See pdfjs-text.util.ts for the full story.
import { Logger } from '@nestjs/common';
import { recognizePages } from '../common/ocr/recognize-text.util';
import { extractPdfText } from '../common/pdf/pdfjs-text.util';
import { renderPdfPagesToImages } from './pdf-to-images.util';

const logger = new Logger('BankStatementParser');

export interface ParsedBankLine {
  lineNo: number;
  transactionDate: Date | null;
  rawDescription: string;
  amount: number;
  cardLast4: string | null;
}

const DATE_DMY = /^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/;
const DATE_YMD = /^(\d{4})-(\d{2})-(\d{2})/;
// Credit-card statements print an amount followed by "CR" (credit - a payment,
// refund, cashback or reimbursement reduces the balance) or occasionally "DR"
// (debit, explicit). Without this suffix in the pattern, every credit line -
// including reimbursements, which are exactly what this app needs to reconcile -
// would silently fail to match and the whole line would be dropped.
const TRAILING_AMOUNT = /(-?(?:Rp\s?)?[\d.,]+)\s*(CR|DR)?\s*$/i;
const CARD_LAST4 = /(?:\*{2,}|x{2,}|ending)\s*[- ]?(\d{4})\b/i;

function parseLeadingDate(text: string): { date: Date | null; rest: string } {
  const dmy = text.match(DATE_DMY);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    return {
      date: new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd))),
      rest: text.slice(dmy[0].length).trim(),
    };
  }
  const ymd = text.match(DATE_YMD);
  if (ymd) {
    const [, yyyy, mm, dd] = ymd;
    return {
      date: new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd))),
      rest: text.slice(ymd[0].length).trim(),
    };
  }
  return { date: null, rest: text };
}

function parseAmount(raw: string): number | null {
  let value = raw.replace(/Rp/i, '').replace(/\s+/g, '').trim();
  const negative = value.startsWith('-');
  value = value.replace(/^-/, '');
  if (!value) return null;

  const hasDot = value.includes('.');
  const hasComma = value.includes(',');

  if (hasDot && hasComma) {
    // Whichever separator appears last is the decimal point.
    const lastDot = value.lastIndexOf('.');
    const lastComma = value.lastIndexOf(',');
    if (lastComma > lastDot) {
      value = value.replace(/\./g, '').replace(',', '.');
    } else {
      value = value.replace(/,/g, '');
    }
  } else if (hasComma) {
    const decimals = value.length - value.lastIndexOf(',') - 1;
    value = decimals === 2 ? value.replace(',', '.') : value.replace(/,/g, '');
  } else if (hasDot) {
    // Indonesian statements use '.' as a thousands separator far more often
    // than as a decimal point, so only treat a single trailing ".NN" as decimal.
    const parts = value.split('.');
    const decimals = parts[parts.length - 1].length;
    if (parts.length > 2 || decimals !== 2) {
      value = value.replace(/\./g, '');
    }
  }

  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return negative ? -num : num;
}

// Parses already-extracted plain text (from pdf-parse or from OCR) into
// transaction lines. `lineNoOffset` lets multi-page OCR keep line numbers
// continuous across pages instead of restarting at 1 on every page.
function parseTransactionLines(text: string, lineNoOffset = 0): ParsedBankLine[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const results: ParsedBankLine[] = [];
  let noLeadingDate = 0;
  let noTrailingAmount = 0;
  lines.forEach((line, idx) => {
    const { date, rest } = parseLeadingDate(line);
    if (!date) {
      noLeadingDate++; // skip headers/footers/non-transaction lines
      return;
    }

    // Credit-card statements commonly print two leading dates - Transaction
    // Date then Posting Date (e.g. MNC Bank's "Tanggal Transaksi"/"Tanggal
    // Pembukuan"). Strip a second one too so it doesn't end up glued onto the
    // description; parseLeadingDate is a no-op (returns rest unchanged) if
    // there isn't one.
    const rest2 = parseLeadingDate(rest).rest;

    const amountMatch = rest2.match(TRAILING_AMOUNT);
    if (!amountMatch) {
      noTrailingAmount++;
      return;
    }
    const amount = parseAmount(amountMatch[1]);
    if (amount === null) {
      noTrailingAmount++;
      return;
    }

    const description = rest2.slice(0, rest2.length - amountMatch[0].length).trim();
    const cardMatch = line.match(CARD_LAST4);

    results.push({
      lineNo: lineNoOffset + idx + 1,
      transactionDate: date,
      rawDescription: description || rest2,
      amount,
      cardLast4: cardMatch ? cardMatch[1] : null,
    });
  });

  // noTrailingAmount lines had a recognized leading date but no parseable
  // trailing amount - unlike noLeadingDate (expected for headers/footers),
  // that's the signature of a bank layout this parser doesn't fully handle.
  if (noTrailingAmount > 0) {
    logger.warn(
      `Parsed ${results.length}/${lines.length} lines as transactions - ${noTrailingAmount} line(s) had a date but no recognizable amount (possible unsupported statement format), ${noLeadingDate} had no leading date (headers/footers).`,
    );
  }

  return results;
}

// A real embedded text layer for a multi-page statement is always far longer
// than this; a near-empty result means the PDF is a scanned/rasterized image
// with nothing to extract.
const MIN_TEXT_LENGTH_FOR_TEXT_LAYER = 200;

export async function parseBankStatementPdf(buffer: Buffer): Promise<ParsedBankLine[]> {
  const extracted = await extractPdfText(buffer);
  if (extracted.text.trim().length >= MIN_TEXT_LENGTH_FOR_TEXT_LAYER) {
    logger.log(`Extracted text layer from ${extracted.numPages} page(s), ${extracted.text.length} chars.`);
    return parseTransactionLines(extracted.text);
  }

  // No usable text layer - render each page to an image and OCR it instead,
  // same engine as the receipt-photo OCR flow.
  logger.log(`No usable text layer (${extracted.text.trim().length} chars) - falling back to OCR.`);
  const pageImages = await renderPdfPagesToImages(buffer);
  const ocrResults = await recognizePages(pageImages);
  const results: ParsedBankLine[] = [];
  ocrResults.forEach(({ text, confidence }, i) => {
    logger.log(`OCR page ${i + 1}/${pageImages.length}: confidence ${confidence.toFixed(1)}, ${text.length} chars.`);
    results.push(...parseTransactionLines(text, results.length));
  });
  return results;
}
