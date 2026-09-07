// Extracts plain text from a PDF's embedded text layer using pdfjs-dist
// directly, instead of the `pdf-parse` package.
//
// Why: `pdf-parse` bundles its own old, standalone pdf.js (v1.10.100). When
// `exceljs` is loaded anywhere in the same process (even just imported, not
// necessarily used) - which happens routinely here since the Import module
// generates/reads .xlsx files - every subsequent pdf-parse call throws
// "Invalid PDF structure" on perfectly valid PDFs. Confirmed by direct
// reproduction (`require('exceljs')` before pdf-parse's first call breaks
// it; the reverse order does NOT reliably help either, e.g. across a full
// Nest app bootstrap). pdfjs-dist (already a dependency via pdf-to-img, used
// for the OCR-fallback path) does not share this conflict, so it replaces
// pdf-parse entirely rather than trying to out-order the corruption.
//
// pdfjs-dist ships ESM-only, so it's loaded via a real dynamic import()
// forced through `new Function` - see pdf-to-images.util.ts for the full
// explanation of why a plain `import()` isn't enough under this project's
// CommonJS build.
type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

async function loadPdfjs(): Promise<PdfjsModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<PdfjsModule>;
  return dynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
}

export interface ExtractedPdfText {
  text: string;
  numPages: number;
}

// pdfjs's getTextContent() returns individual text runs with x/y position,
// not pre-joined lines - reconstruct lines by grouping runs that share a Y
// coordinate (rounded, since PDF coordinates rarely land on the exact same
// float across runs on the same visual line), then sort each line's runs
// left-to-right and lines top-to-bottom, matching what pdf-parse's line-per-
// row output looked like (which bank-statement-parser.util.ts is written for).
export async function extractPdfText(buffer: Buffer): Promise<ExtractedPdfText> {
  const pdfjsLib = await loadPdfjs();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    disableFontFace: true,
  });
  const doc = await loadingTask.promise;

  const pageTexts: string[] = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();

    const linesByY = new Map<number, { x: number; str: string }[]>();
    for (const item of content.items as { str?: string; transform?: number[] }[]) {
      if (!item.str || !item.transform) continue;
      const y = Math.round(item.transform[5]);
      const run = linesByY.get(y) ?? [];
      run.push({ x: item.transform[4], str: item.str });
      linesByY.set(y, run);
    }

    const sortedY = [...linesByY.keys()].sort((a, b) => b - a);
    const lines = sortedY.map((y) =>
      linesByY
        .get(y)!
        .sort((a, b) => a.x - b.x)
        .map((run) => run.str)
        .join(' '),
    );
    pageTexts.push(lines.join('\n'));

    await page.cleanup();
  }

  await loadingTask.destroy();
  return { text: pageTexts.join('\n'), numPages: doc.numPages };
}
