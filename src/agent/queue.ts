/**
 * Serial queue: the data workspace is shared, so inferences run one at a time.
 * Callers wait their turn; the health endpoint exposes queue depth.
 */
import { getLogger, since } from "../lib/logger.js";

const log = getLogger("queue");

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private _pending = 0;
  private _running = false;
  private counter = 0;

  public get pending(): number {
    return this._pending;
  }

  public get running(): boolean {
    return this._running;
  }

  public run<T>(task: () => Promise<T>, label = "task"): Promise<T> {
    const no = ++this.counter;
    const enqueued = Date.now();
    this._pending += 1;
    log.debug("enqueued", { no, label, pending: this._pending, running: this._running });
    const next = this.tail.then(async () => {
      this._pending -= 1;
      this._running = true;
      const started = Date.now();
      log.debug("started", { no, label, waitedMs: since(enqueued), pending: this._pending });
      try {
        return await task();
      } catch (error) {
        log.error("task threw", error, { no, label });
        throw error;
      } finally {
        this._running = false;
        log.debug("finished", { no, label, durationMs: since(started), pending: this._pending });
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}
