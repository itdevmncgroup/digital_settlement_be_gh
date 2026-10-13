// Renders each page of a PDF to a PNG image buffer, for OCR'ing bank
// statement PDFs that have no extractable text layer (e.g. a scanned/"print
// to PDF" statement - see bank-statement-parser.util.ts).
//
// pdf-to-img ships ESM-only ("type": "module" in its package.json) while this
// backend compiles to CommonJS, so a normal top-level `import`/`require`
// throws ERR_REQUIRE_ESM. `import('pdf-to-img')` written directly gets
// downleveled by tsc (module: commonjs) into `require('pdf-to-img')`, which
// hits the same error - so the dynamic import is built via `new Function(...)`
// instead, which hides it from tsc's transform and forces a real ESM import
// at runtime. The `typeof import('pdf-to-img')` type reference below is
// type-only and erased at compile time, so it doesn't trigger the same issue.
type PdfToImgModule = typeof import('pdf-to-img');

async function loadPdfToImg(): Promise<PdfToImgModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<PdfToImgModule>;
  return dynamicImport('pdf-to-img');
}

// 1x page resolution is too low for Tesseract to read a dense transaction
// table reliably; 3x renders sharp enough for consistently good OCR results.
const RENDER_SCALE = 3;

// Yields one page at a time rather than returning the whole array: a 3x-scale
// page render is ~100MB of RSS while it's alive, so collecting every page of a
// long statement first can exhaust memory and kill the process mid-request
// (which the frontend proxy sees as an ECONNRESET). Streaming lets each page
// be OCR'd and released before the next is rendered.
export async function* streamPdfPagesToImages(buffer: Buffer, scale = RENDER_SCALE): AsyncGenerator<Buffer> {
  const { pdf } = await loadPdfToImg();
  const doc = await pdf(buffer, { scale });
  for await (const page of doc) {
    yield page as Buffer;
  }
}

// Renders only the requested 1-based pages (e.g. the ones holding a matched
// transaction) instead of streaming the whole file - used by the Settlement PDF.
export async function renderPdfPages(buffer: Buffer, pageNos: number[], scale = 2): Promise<Map<number, Buffer>> {
  const { pdf } = await loadPdfToImg();
  const doc = await pdf(buffer, { scale });
  const out = new Map<number, Buffer>();
  for (const pageNo of pageNos) {
    if (pageNo < 1 || pageNo > doc.length) continue;
    out.set(pageNo, (await doc.getPage(pageNo)) as Buffer);
  }
  return out;
}
