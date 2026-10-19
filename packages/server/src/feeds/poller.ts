// Background scheduler: every few seconds, check whatever sources are due.
// Sources are checked one at a time; HostLimiter spaces out requests to the same site.
import type { FeedService, Logger } from "./service.js";

export class Poller {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    private readonly feeds: FeedService,
    private readonly log: Logger & { error(obj: object, msg?: string): void },
    private readonly tickMs = 15_000,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(1_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  /** One pass over due sources. Public for tests. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const id of await this.feeds.dueSourceIds()) {
        if (this.stopped) break;
        await this.feeds.checkSource(id);
      }
    } catch (err) {
      this.log.error({ err }, "poller pass failed");
    } finally {
      this.running = false;
      this.schedule(this.tickMs);
    }
  }
}
