import { createWorker, recognize } from 'tesseract.js';
import sharp from 'sharp';

export interface OcrTextResult {
  text: string;
  confidence: number;
}

// Phone-camera receipt photos in the wild are often small (~400px wide) with
// tiny glyph heights, which is the single biggest driver of poor Tesseract
// accuracy - upscaling to a minimum width before OCR consistently raises
// confidence. Scanned/rasterized PDF pages are typically already well above
// this width, so the resize is a no-op for them.
const MIN_OCR_WIDTH = 1600;

// Upscale + mild contrast/sharpen pass. Best-effort: if the buffer isn't a
// format sharp understands (or anything else goes wrong), fall back to the
// original buffer rather than failing the scan.
async function preprocess(buffer: Buffer): Promise<Buffer> {
  try {
    const image = sharp(buffer);
    const { width } = await image.metadata();
    const resized = width && width < MIN_OCR_WIDTH ? image.resize({ width: MIN_OCR_WIDTH, kernel: 'lanczos3' }) : image;
    return await resized.grayscale().normalize().sharpen().toBuffer();
  } catch {
    return buffer;
  }
}

// Shared low-level Tesseract call - used by both the receipt-photo OCR
// (OcrService, ParsedReceipt) and the bank-statement-PDF OCR fallback
// (bank-statement-parser.util.ts, for scanned/rasterized statement PDFs that
// have no extractable text layer). Keeps the language pack/options in one place.
export async function recognizeText(buffer: Buffer): Promise<OcrTextResult> {
  const preprocessed = await preprocess(buffer);
  const { data } = await recognize(preprocessed, 'eng+ind');
  return { text: data.text, confidence: data.confidence };
}

// Multi-page variant (bank-statement OCR fallback). The top-level `recognize`
// above spawns and terminates a worker per call; running every page of a
// statement through one worker keeps that spin-up out of the per-page loop.
export async function recognizePages(buffers: Buffer[]): Promise<OcrTextResult[]> {
  const worker = await createWorker('eng+ind');
  try {
    const results: OcrTextResult[] = [];
    for (const buffer of buffers) {
      const preprocessed = await preprocess(buffer);
      const { data } = await worker.recognize(preprocessed);
      results.push({ text: data.text, confidence: data.confidence });
    }
    return results;
  } finally {
    await worker.terminate();
  }
}
