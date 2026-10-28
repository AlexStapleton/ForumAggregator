// The worker thread that reads big pages (D-107): building a forum page's document takes 0.2–1 s
// (seconds on a Pi), which would otherwise stop the server answering anything else meanwhile.
import { parentPort } from "node:worker_threads";
import { runPageJob, type PageJob } from "./pageParser.js";

parentPort!.on("message", (job: PageJob & { id: number }) => {
  try {
    const result = runPageJob(job);
    parentPort!.postMessage({ id: job.id, result });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: (err as Error).message ?? String(err) });
  }
});
