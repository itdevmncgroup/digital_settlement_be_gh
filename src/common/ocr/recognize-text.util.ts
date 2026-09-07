import { recognize } from 'tesseract.js';

export interface OcrTextResult {
  text: string;
  confidence: number;
}

// Shared low-level Tesseract call - used by both the receipt-photo OCR
// (OcrService, ParsedReceipt) and the bank-statement-PDF OCR fallback
// (bank-statement-parser.util.ts, for scanned/rasterized statement PDFs that
// have no extractable text layer). Keeps the language pack/options in one place.
export async function recognizeText(buffer: Buffer): Promise<OcrTextResult> {
  const { data } = await recognize(buffer, 'eng+ind');
  return { text: data.text, confidence: data.confidence };
}
