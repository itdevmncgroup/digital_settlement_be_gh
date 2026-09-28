import { TextractClient, DetectDocumentTextCommand } from '@aws-sdk/client-textract';
import type { OcrProvider, OcrTextResult } from './types';

// Dedicated AWS_* creds (standard SDK env var names) rather than reusing
// S3_ACCESS_KEY/S3_SECRET_KEY - Textract is a separate AWS service and may
// live under a different IAM principal than the S3 bucket. Falls back to the
// SDK's default credential provider chain (shared config, IAM role, ...) if unset.
function client(): TextractClient {
  const region = process.env.AWS_REGION || 'us-east-1';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  return new TextractClient({
    region,
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  });
}

async function detect(buffer: Buffer): Promise<OcrTextResult> {
  const res = await client().send(new DetectDocumentTextCommand({ Document: { Bytes: buffer } }));
  const lines = (res.Blocks ?? []).filter((b) => b.BlockType === 'LINE');
  const text = lines.map((l) => l.Text ?? '').join('\n');
  const confidences = lines.map((l) => l.Confidence ?? 0).filter((c) => c > 0);
  const confidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
  return { text, confidence };
}

async function recognizePages(pages: AsyncIterable<Buffer>): Promise<OcrTextResult[]> {
  const results: OcrTextResult[] = [];
  for await (const buffer of pages) {
    results.push(await detect(buffer));
  }
  return results;
}

export const textractOcrProvider: OcrProvider = { recognizeText: detect, recognizePages };
