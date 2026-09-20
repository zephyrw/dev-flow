export class AgyDomainCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;

  isBusy(): boolean {
    return this.pending > 0;
  }

  async enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.pending++;
    const run = async () => {
      try {
        return await task();
      } finally {
        this.pending--;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
}
