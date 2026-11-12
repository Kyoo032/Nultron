/**
 * A video job the gateway accepted and was still rendering when the app stopped watching it.
 *
 * It is not a failure and it is not a refusal: the job may well finish, and when it does the gateway
 * bills it. So nothing downstream may submit the same brief again on the strength of it. The harness
 * (`harness.ts`), the Edit generate job (`packages/host/src/edit/generate.ts`) and the message regex in
 * `videoRenderShouldRetry` all read this one code.
 */
export const VIDEO_JOB_PENDING_CODE = "video_job_pending";

/** 504: the wait ran out. The gateway did not answer "failed". */
export const VIDEO_JOB_PENDING_STATUS = 504;
