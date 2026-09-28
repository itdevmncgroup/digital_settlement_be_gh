import { createWorker, recognize } from 'tesseract.js';
import sharp from 'sharp';
import type { OcrProvider, OcrTextResult } from './types';

// tesseract.js's own default (no langPath, oem 1) already downloads the
// integerized tessdata_best files - it is NOT the "fast" tier despite being
// the library default. OCR_TRAINED_DATA lets ops pick an explicit tier by
// pointing langPath at the same CDN (tessdata.projectnaptha.com, the host
// tesseract.js itself uses) that also publishes the true fast/best sets:
// - "fast"  -> tessdata_fast (smallest/quickest, lowest accuracy)
// - "best"  -> tessdata_best (float, largest/slowest, highest accuracy)
// - unset   -> library default (integerized best_int) - unchanged behavior.
const TESSDATA_CDN = 'https://tessdata.projectnaptha.com';

function resolveLangPath(): string | undefined {
  const tier = process.env.OCR_TRAINED_DATA?.trim().toLowerCase();
  if (tier === 'fast') return `${TESSDATA_CDN}/4.0.0_fast`;
  if (tier === 'best') return `${TESSDATA_CDN}/4.0.0_best`;
  return undefined;
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

async function recognizeText(buffer: Buffer): Promise<OcrTextResult> {
  const preprocessed = await preprocess(buffer);
  const langPath = resolveLangPath();
  const { data } = await recognize(preprocessed, 'eng+ind', langPath ? { langPath } : undefined);
  return { text: data.text, confidence: data.confidence };
}

// Tesseract.js's WASM heap is known to grow with every `.recognize()` call on
// a worker and never shrink back down, regardless of how promptly the caller
// releases each page's JS buffer - a long statement (many pages) can run a
// single worker's memory up far enough to crash the whole Node process
// mid-request (surfaces to the frontend as a bare ECONNRESET, no clean 500).
// Recycling the worker every few pages bounds that growth at the cost of a
// few extra spin-ups for a long document.
const PAGES_PER_WORKER = 10;

async function recognizePages(pages: AsyncIterable<Buffer>): Promise<OcrTextResult[]> {
  const results: OcrTextResult[] = [];
  const langPath = resolveLangPath();
  let worker = await createWorker('eng+ind', undefined, langPath ? { langPath } : undefined);
  let pagesOnWorker = 0;
  try {
    for await (const buffer of pages) {
      if (pagesOnWorker >= PAGES_PER_WORKER) {
        await worker.terminate();
        worker = await createWorker('eng+ind', undefined, langPath ? { langPath } : undefined);
        pagesOnWorker = 0;
      }
      const preprocessed = await preprocess(buffer);
      const { data } = await worker.recognize(preprocessed);
      results.push({ text: data.text, confidence: data.confidence });
      pagesOnWorker++;
    }
    return results;
  } finally {
    await worker.terminate();
  }
}

export const tesseractOcrProvider: OcrProvider = { recognizeText, recognizePages };
