/**
 * Serial queue: the data workspace is shared, so inferences run one at a time.
 * Callers wait their turn; the health endpoint exposes queue depth.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private _pending = 0;
  private _running = false;

  public get pending(): number {
    return this._pending;
  }

  public get running(): boolean {
    return this._running;
  }

  public run<T>(task: () => Promise<T>): Promise<T> {
    this._pending += 1;
    const next = this.tail.then(async () => {
      this._pending -= 1;
      this._running = true;
      try {
        return await task();
      } finally {
        this._running = false;
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}
