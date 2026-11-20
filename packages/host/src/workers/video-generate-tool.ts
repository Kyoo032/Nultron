import { VIDEO_POLL_DEADLINE_MS, VIDEO_POLL_REQUEST_MS, videoGenerateTool } from "@agentforge/core";
import { keepRunAlive } from "./worker-channel";

/**
 * How long a chat turn is kept alive for one video render: the tool's own wait, one slow status request
 * past it, and a margin. It stays under `WORKER_STREAM_IDLE_MS` (10 minutes), the model stream's own
 * budget while this tool runs, so the tool's answer, "still rendering" included, is always the thing
 * that ends the wait.
 */
const VIDEO_KEEP_ALIVE_MS = VIDEO_POLL_DEADLINE_MS + VIDEO_POLL_REQUEST_MS + 30_000;

/**
 * `video_generate` as Chat calls it. Core's tool polls the gateway for minutes without a sound (a 15 s
 * Seedance clip took 105 s at 480p), which is longer than a chat run's 60 s idle budget: the turn was
 * ended with "no stream events" while the render went on and billed, and the clip had nowhere to land.
 * The same tool, with the run kept alive while it waits. The Videos studio and the Edit jobs call core's
 * tool directly and have no chat run to keep.
 */
export const chatVideoGenerateTool: typeof videoGenerateTool = {
  ...videoGenerateTool,
  execute: (args, tenant) => keepRunAlive(() => videoGenerateTool.execute(args, tenant), { maxMs: VIDEO_KEEP_ALIVE_MS }),
};
