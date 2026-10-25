export class AgyDomainCoordinator {
  private running = false;
  private foreground: Array<() => Promise<void>> = [];
  private interactive: Array<() => Promise<void>> = [];
  private background: Array<() => Promise<void>> = [];

  isBusy(): boolean {
    return this.running || this.interactive.length + this.foreground.length + this.background.length > 0;
  }

  enqueue<T>(task: () => Promise<T>, priority: "interactive" | "foreground" | "background" = "foreground"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this[priority].push(async () => {
        try { resolve(await task()); } catch (error) { reject(error); }
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let next: (() => Promise<void>) | undefined;
      while ((next = this.interactive.shift() ?? this.foreground.shift() ?? this.background.shift())) await next();
    } finally { this.running = false; }
  }
}
