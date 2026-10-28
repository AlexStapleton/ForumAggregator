// Reading web pages (article extraction, forum thread pages) off the main thread (D-107).
// One worker thread does them one at a time; the server keeps answering meanwhile. When the
// compiled worker isn't there (tests run the TypeScript sources), pages are read in-process.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { ForumThreadPage } from "./extract.js";
import { extractWithSelectors, type ReaderSelectors, type SelectorExtraction } from "./extract.js";
import { parseThreadPage } from "../feeds/thread.js";
import { parseBoardPage, type BoardPage } from "../feeds/board.js";

export type PageJob =
  | { kind: "extract"; html: string; url: string; selectors: ReaderSelectors }
  | { kind: "thread"; html: string; url: string }
  | { kind: "board"; html: string; url: string };

/** Does one job; the same code in the worker and in-process. */
export function runPageJob(job: PageJob): unknown {
  return job.kind === "thread" ? parseThreadPage(job.html, job.url)
    : job.kind === "board" ? parseBoardPage(job.html, job.url)
    : extractWithSelectors(job.html, job.url, job.selectors);
}

/** A page that takes longer than this is given up on (and the worker replaced). */
const JOB_TIMEOUT_MS = 30_000;
/** A fresh worker now and then keeps its memory from creeping up over weeks. */
const JOBS_PER_WORKER = 500;

const WORKER_FILE = fileURLToPath(new URL("./pageWorker.js", import.meta.url));

interface Pending {
  job: PageJob;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class PageParser {
  private worker: Worker | null = null;
  private jobsDone = 0;
  private nextId = 1;
  private queue: Array<Pending & { id: number }> = [];
  private running: (Pending & { id: number; timer: NodeJS.Timeout }) | null = null;

  /** FA_PAGE_WORKER=0 reads pages in-process (an escape hatch; slower to answer meanwhile). */
  constructor(private readonly useWorker = process.env.FA_PAGE_WORKER !== "0" && fs.existsSync(WORKER_FILE)) {}

  extract(html: string, url: string, selectors: ReaderSelectors): Promise<SelectorExtraction> {
    return this.run({ kind: "extract", html, url, selectors }) as Promise<SelectorExtraction>;
  }

  thread(html: string, url: string): Promise<ForumThreadPage | null> {
    return this.run({ kind: "thread", html, url }) as Promise<ForumThreadPage | null>;
  }

  /** A vBulletin board page's threads (D-123). */
  board(html: string, url: string): Promise<BoardPage | null> {
    return this.run({ kind: "board", html, url }) as Promise<BoardPage | null>;
  }

  private run(job: PageJob): Promise<unknown> {
    if (!this.useWorker) {
      try {
        return Promise.resolve(runPageJob(job));
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, job, resolve, reject });
      this.next();
    });
  }

  private next() {
    if (this.running || !this.queue.length) return;
    const item = this.queue.shift()!;
    const worker = this.ensureWorker();
    const timer = setTimeout(() => this.fail(new Error("Reading the page took too long.")), JOB_TIMEOUT_MS);
    this.running = { ...item, timer };
    worker.postMessage({ id: item.id, ...item.job });
  }

  private ensureWorker(): Worker {
    if (this.worker && this.jobsDone < JOBS_PER_WORKER) return this.worker;
    void this.worker?.terminate();
    this.jobsDone = 0;
    const worker = new Worker(WORKER_FILE);
    // Doesn't keep the process alive by itself (the HTTP server does).
    worker.unref();
    worker.on("message", (msg: { id: number; result?: unknown; error?: string }) => {
      const running = this.running;
      if (!running || running.id !== msg.id) return;
      clearTimeout(running.timer);
      this.running = null;
      this.jobsDone++;
      if (msg.error !== undefined) running.reject(new Error(msg.error));
      else running.resolve(msg.result);
      this.next();
    });
    worker.on("error", (err) => this.fail(err));
    worker.on("exit", () => {
      if (this.worker === worker) this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  /** The running job failed with its worker (crash or timeout): reject it, start over with a new worker. */
  private fail(err: Error) {
    const running = this.running;
    this.running = null;
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate();
    if (running) {
      clearTimeout(running.timer);
      running.reject(err);
    }
    this.next();
  }

  async close() {
    for (const p of this.queue.splice(0)) p.reject(new Error("Shutting down"));
    if (this.running) this.fail(new Error("Shutting down"));
    await this.worker?.terminate();
    this.worker = null;
  }
}

/** The app's one page parser. */
export const pageParser = new PageParser();
