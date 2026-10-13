// Per-page text lines of a PDF with their vertical position, so a caller can
// locate (and highlight) a specific line on the rendered page image. Same
// pdfjs-dist loader as pdfjs-text.util.ts; coordinates are in PDF points with
// the origin at the page's top-left (rotation already applied by the viewport).
import { loadPdfjs } from './pdfjs-text.util';

export interface PdfPageLine {
  text: string;
  top: number;
  bottom: number;
}

export interface PdfPageLines {
  pageNo: number;
  width: number;
  height: number;
  lines: PdfPageLine[];
}

export async function extractPdfPageLines(buffer: Buffer): Promise<PdfPageLines[]> {
  const pdfjsLib = await loadPdfjs();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false, disableFontFace: true });
  const doc = await loadingTask.promise;
  const pages: PdfPageLines[] = [];
  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const byY = new Map<number, { x: number; str: string; height: number }[]>();
      for (const item of content.items as { str?: string; transform?: number[]; height?: number }[]) {
        if (!item.str || !item.transform) continue;
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        const key = Math.round(y);
        const run = byY.get(key) ?? [];
        run.push({ x, str: item.str, height: item.height || 10 });
        byY.set(key, run);
      }

      const lines = [...byY.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([y, runs]) => {
          const height = Math.max(...runs.map((r) => r.height));
          return {
            text: runs.sort((a, b) => a.x - b.x).map((r) => r.str).join(' '),
            top: y - height,
            bottom: y + height * 0.3,
          };
        });
      pages.push({ pageNo, width: viewport.width, height: viewport.height, lines });
      await page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages;
}
