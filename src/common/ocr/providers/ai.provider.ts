import Anthropic from '@anthropic-ai/sdk';
import type { OcrProvider, OcrTextResult } from './types';

let cachedClient: Anthropic | undefined;
function client(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: process.env.OCR_AI_API_KEY || process.env.ANTHROPIC_API_KEY });
  }
  return cachedClient;
}

// PNG vs JPEG is the only distinction that matters here - every buffer this
// module receives comes from sharp/pdf-to-img output (see preprocessing
// callers), never an arbitrary user-uploaded format.
function detectMediaType(buffer: Buffer): 'image/png' | 'image/jpeg' {
  return buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 ? 'image/png' : 'image/jpeg';
}

const TRANSCRIBE_PROMPT =
  'Transcribe every visible line of text in this receipt/document image exactly as printed, preserving line breaks and layout order. Output only the transcribed text, no commentary or markdown.';

async function recognize(buffer: Buffer): Promise<OcrTextResult> {
  const model = process.env.OCR_AI_MODEL || 'claude-sonnet-5';
  const message = await client().messages.create({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: detectMediaType(buffer), data: buffer.toString('base64') } },
          { type: 'text', text: TRANSCRIBE_PROMPT },
        ],
      },
    ],
  });
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  // Vision LLMs don't expose a calibrated per-character confidence score like
  // Tesseract/Textract - fixed at a high constant since a completed
  // transcription from this model is reliably legible.
  return { text, confidence: 95 };
}

async function recognizePages(pages: AsyncIterable<Buffer>): Promise<OcrTextResult[]> {
  const results: OcrTextResult[] = [];
  for await (const buffer of pages) {
    results.push(await recognize(buffer));
  }
  return results;
}

export const aiOcrProvider: OcrProvider = { recognizeText: recognize, recognizePages };
