// Per-route JSONL capture logger for 4-point request/response pipeline debugging.
//
// Capture points:
//   1. claude_in    — raw request from Claude Code (Anthropic format)
//   2. provider_out — transformed request sent to provider API
//   3. provider_in  — raw response from provider API (before transformation)
//   4. claude_out   — final response returned to Claude Code (Anthropic format)
//
// Log file is named after the active route set: capture-{routeName}.jsonl

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export class CaptureLogger {
  private dir: string;
  private filePath: string;

  constructor(logsDir: string, routeName: string) {
    this.dir = logsDir;
    this.filePath = join(this.dir, `capture-${routeName}.jsonl`);
    mkdirSync(this.dir, { recursive: true });
  }

  /** Log a non-streaming data point as a single JSONL line */
  log(provider: string, point: string, data: Record<string, any>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), point, ...data }) + '\n';
    appendFileSync(this.filePath, line);
  }

  /**
   * Tee a ReadableStream: returns [streamForPipeline, capturePromise].
   * The pipeline stream is returned immediately; the capture drains in the background.
   */
  teeAndCapture(
    stream: ReadableStream<Uint8Array>,
    provider: string,
    point: string,
    meta: Record<string, any>,
  ): [ReadableStream<Uint8Array>, Promise<void>] {
    const [s1, s2] = stream.tee();
    const capturePromise = this.drainStreamToFile(s2, provider, point, meta);
    return [s1, capturePromise];
  }

  private async drainStreamToFile(
    stream: ReadableStream<Uint8Array>,
    provider: string,
    point: string,
    meta: Record<string, any>,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
    this.log(provider, point, { ...meta, body: chunks.join('') });
  }
}
