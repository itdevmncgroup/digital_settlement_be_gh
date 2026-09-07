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

const SUBTOTAL_RE = /sub[\s-]*total/i;
const TAX_RE = /(ppn|pajak|tax)/i;
const SERVICE_CHARGE_RE = /(service\s*charge|biaya\s*layanan|order\s*fee)/i;
const TOTAL_RE = /^\s*(grand\s*total|total)\b/i;

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
    const merchantName = lines[0] ?? null;

    let subtotal: number | null = null;
    let tax: number | null = null;
    let serviceCharge: number | null = null;
    let total: number | null = null;
    let totalsStartIndex = lines.length;

    lines.forEach((line, i) => {
      const numberMatch = line.match(TRAILING_NUMBER);
      const value = numberMatch ? parseIdrNumber(numberMatch[1]) : null;
      if (value === null) return;

      if (SUBTOTAL_RE.test(line)) {
        subtotal = value;
        totalsStartIndex = Math.min(totalsStartIndex, i);
      } else if (SERVICE_CHARGE_RE.test(line)) {
        serviceCharge = value;
        totalsStartIndex = Math.min(totalsStartIndex, i);
      } else if (TAX_RE.test(line)) {
        tax = value;
        totalsStartIndex = Math.min(totalsStartIndex, i);
      } else if (TOTAL_RE.test(line)) {
        total = value;
        totalsStartIndex = Math.min(totalsStartIndex, i);
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

    return { rawText, confidence, merchantName, items: resolvedItems, subtotal, tax, serviceCharge, total, warnings };
  }
}
