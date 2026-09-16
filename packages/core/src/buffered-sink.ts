import { StringDecoder } from "node:string_decoder";

export interface BufferedSinkOptions {
  maxBytes?: number;
  flushIntervalMs?: number;
  maxMemoryBytes?: number;
  onFlush: (chunk: string) => void | Promise<void>;
}

/** Bounded FIFO. A false write return asks the producer to pause until flush
 * settles; writeAsync provides the same backpressure for async producers.
 * The UTF8 decoder retains at most three additional incomplete bytes. */
export class BufferedEventSink {
  private decoder = new StringDecoder("utf8");
  private buffer: Buffer[] = [];
  private bufferBytes = 0;
  private queue: Buffer[] = [];
  private bytes = 0;
  private timer?: NodeJS.Timeout;
  private processing?: Promise<void>;
  private failure?: Error;
  private closed = false;
  private readonly limit: number;
  private readonly threshold: number;
  constructor(private readonly options: BufferedSinkOptions) {
    this.limit = options.maxMemoryBytes ?? 2 * 1024 * 1024;
    this.threshold = Math.min(options.maxBytes ?? 65536, this.limit);
    if (this.limit < 1 || this.threshold < 1)
      throw new Error("Invalid buffer limit");
  }
  get bufferedBytes() {
    return this.bytes;
  }
  write(chunk: string | Buffer): boolean {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("BufferedEventSink is closed");
    const size = Buffer.byteLength(chunk);
    if (this.bytes + size > this.limit) {
      throw new Error(
        "BUFFER_BACKPRESSURE: await flush before writing more data",
      );
    }
    this.buffer.push(Buffer.from(chunk));
    this.bufferBytes += size;
    this.bytes += size;
    if (this.bufferBytes >= this.threshold) {
      this.flush().catch(() => {
        /* failure is retained for close/next write */
      });
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.flush().catch(() => {});
      }, this.options.flushIntervalMs ?? 500);
    }
    return this.bytes < this.limit;
  }
  async writeAsync(chunk: string | Buffer): Promise<void> {
    const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (let offset = 0; offset < data.length; ) {
      if (this.failure) throw this.failure;
      const available = this.limit - this.bytes;
      if (!available) {
        await this.flush();
        continue;
      }
      const end = Math.min(data.length, offset + available);
      this.write(data.subarray(offset, end));
      offset = end;
      if (offset < data.length) await this.flush();
    }
  }
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.failure) return Promise.reject(this.failure);
    if (this.bufferBytes) {
      this.queue.push(Buffer.concat(this.buffer, this.bufferBytes));
      this.buffer = [];
      this.bufferBytes = 0;
    }
    if (this.processing) return this.processing;
    if (!this.queue.length) return Promise.resolve();
    // Defer drain until processing is assigned, including synchronous sinks.
    const pending = Promise.resolve()
      .then(async () => {
        while (this.queue.length) {
          const chunk = this.queue.shift()!;
          const text = this.decoder.write(chunk);
          if (text) await this.options.onFlush(text);
          this.bytes -= chunk.length;
        }
      })
      .catch((error: unknown) => {
        this.failure =
          error instanceof Error ? error : new Error(String(error));
        this.queue = [];
        this.buffer = [];
        this.bufferBytes = 0;
        this.bytes = 0;
        throw this.failure;
      })
      .finally(() => {
        this.processing = undefined;
        if (this.queue.length && !this.failure) return this.flush();
      });
    this.processing = pending;
    // Automatic flush must never emit unhandled rejections.
    pending.catch(() => {});
    return pending;
  }
  private closing?: Promise<void>;
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.flush();
      const tail = this.decoder.end();
      if (tail) await this.options.onFlush(tail);
      if (this.failure) throw this.failure;
    })().catch((error) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw this.failure;
    });
    this.closing.catch(() => {});
    return this.closing;
  }
}
