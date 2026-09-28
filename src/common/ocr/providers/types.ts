export interface OcrTextResult {
  text: string;
  confidence: number;
}

// Common contract every OCR backend (Tesseract/AWS Textract/AI vision API)
// implements, selected at runtime by OCR_PROVIDER - see ../recognize-text.util.ts.
export interface OcrProvider {
  recognizeText(buffer: Buffer): Promise<OcrTextResult>;
  recognizePages(pages: AsyncIterable<Buffer>): Promise<OcrTextResult[]>;
}
