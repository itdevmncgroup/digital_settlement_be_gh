import type { OcrProvider, OcrTextResult } from './providers/types';
import { tesseractOcrProvider } from './providers/tesseract.provider';
import { textractOcrProvider } from './providers/textract.provider';
import { aiOcrProvider } from './providers/ai.provider';

export type { OcrTextResult };

// Shared low-level OCR entry point - used by both the receipt-photo OCR
// (OcrService, ParsedReceipt) and the bank-statement-PDF OCR fallback
// (bank-statement-parser.util.ts, for scanned/rasterized statement PDFs that
// have no extractable text layer). OCR_PROVIDER picks the backend:
//   tesseract (default) -> local tesseract.js, no external calls/credentials
//   textract             -> AWS Textract DetectDocumentText (AWS_* creds)
//   ai                   -> Claude vision transcription (OCR_AI_API_KEY/ANTHROPIC_API_KEY)
// See providers/*.provider.ts for each backend's implementation.
function resolveProvider(): OcrProvider {
  const provider = process.env.OCR_PROVIDER?.trim().toLowerCase();
  if (provider === 'textract') return textractOcrProvider;
  if (provider === 'ai') return aiOcrProvider;
  return tesseractOcrProvider;
}

export function recognizeText(buffer: Buffer): Promise<OcrTextResult> {
  return resolveProvider().recognizeText(buffer);
}

// Multi-page variant (bank-statement OCR fallback). Takes an async iterable
// so pages can be rendered lazily - see streamPdfPagesToImages on why the
// whole set must not be held in memory.
export function recognizePages(pages: AsyncIterable<Buffer>): Promise<OcrTextResult[]> {
  return resolveProvider().recognizePages(pages);
}
