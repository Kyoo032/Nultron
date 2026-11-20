import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VIDEO_JOB_PENDING_CODE, modeMessage, outputLanguageRule, type TenantContext } from "@agentforge/core";
import { db, ensureLocalOwner } from "@agentforge/db";
import { saveModelCache } from "./model-cache";
import { resetCatalogMemo } from "./selectable-models";
import { getStudioMediaMeta } from "./studio-media-meta";
import { generateStudioVideo, type VideoGenerateOptions } from "./studio-generate";

let tenant: TenantContext;

const clip = `data:video/mp4;base64,${Buffer.from("stub-clip").toString("base64")}`;

function listedModels(): void {
  saveModelCache({
    openai: [
      { id: "grok-imagine-video", label: "Grok Imagine Video", provider: "openai", inputModalities: ["text"] },
      { id: "seedance-2.0-fast", label: "Seedance Fast", provider: "openai", inputModalities: ["text"] },
      { id: "veo_3_1-fast", label: "Veo", provider: "openai", inputModalities: ["text"] },
      { id: "mj_video", label: "MJ Video", provider: "openai", inputModalities: ["text"] },
    ],
  });
  resetCatalogMemo();
}

describe("videos harness on generate", () => {
  beforeAll(async () => {
    tenant = await ensureLocalOwner(db);
  });

  afterAll(async () => {
    const { sql } = await import("@agentforge/db");
    sql.close();
  });

  it("runs the shot, one retry, and keeps the billed clip", async () => {
    listedModels();
    // A model whose lengths include 5 s (`media-params-table.ts`), so this case stays about the retry and
    // the kept clip; the snapped length has its own case below (Veo asks 5 s, renders 4 s).
    const model = "seedance-2.0-fast";
    const prompts: string[] = [];
    const options: VideoGenerateOptions = {
      renderVideo: async (call) => {
        prompts.push(call.prompt);
        if (prompts.length === 1) {
          return { success: false, error: "job timed out" };
        }
        expect(call.seconds).toBe(5);
        return { success: true, video: clip, model: call.model };
      },
    };
    const result = await generateStudioVideo(
      tenant,
      { prompt: "a cat in the rain", aspect: "16:9", model, seconds: 5 },
      options,
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Subject: a cat in the rain");
    expect(prompts[0]).toContain(outputLanguageRule("videos", "en"));
    expect(result.prompt).toBe("a cat in the rain");
    expect(result.id).toBeTruthy();
    const meta = await getStudioMediaMeta(tenant.tenantId, result.id ?? "");
    expect(meta?.prompt).toContain("Subject: a cat in the rain");
    expect(meta?.durationSeconds).toBe(5);
  });

  it("bills the snapped Veo length", async () => {
    listedModels();
    let seconds = 0;
    const result = await generateStudioVideo(
      tenant,
      { prompt: "waves on a dock", aspect: "16:9", model: "veo_3_1-fast", seconds: 5 },
      {
        renderVideo: async (call) => {
          seconds = call.seconds;
          return { success: true, video: clip, model: call.model };
        },
      },
    );
    expect(seconds).toBe(4);
    const meta = await getStudioMediaMeta(tenant.tenantId, result.id ?? "");
    expect(meta?.durationSeconds).toBe(4);
  });

  it("does not render a still the model cannot take", async () => {
    listedModels();
    let calls = 0;
    await expect(
      generateStudioVideo(
        tenant,
        {
          prompt: "animate this",
          aspect: "16:9",
          model: "mj_video",
          imageUrl: "https://cdn.example/still.png",
        },
        {
          renderVideo: async () => {
            calls += 1;
            return { success: true, video: clip, model: "mj_video" };
          },
        },
      ),
    ).rejects.toMatchObject({ code: "video_still_unsupported" });
    expect(calls).toBe(0);
  });

  it("renders a job the gateway still has exactly once, and says so in words that are not 'timed out'", async () => {
    listedModels();
    let renders = 0;
    const error = await generateStudioVideo(
      tenant,
      { prompt: "a long slow pour", aspect: "16:9", model: "seedance-2.0-fast", seconds: 15 },
      {
        renderVideo: async () => {
          renders += 1;
          return {
            success: false,
            error: "Gateway video job timed out",
            code: VIDEO_JOB_PENDING_CODE,
          };
        },
      },
    ).catch((caught: unknown) => caught);
    expect(renders).toBe(1);
    expect(error).toMatchObject({ code: VIDEO_JOB_PENDING_CODE, status: 504 });
    expect((error as Error).message).toBe(modeMessage("videoJobPending", "en"));
  });

  it("still renders once more a job that died before the gateway had it", async () => {
    listedModels();
    let renders = 0;
    await generateStudioVideo(
      tenant,
      { prompt: "a cat on a wall", aspect: "16:9", model: "seedance-2.0-fast", seconds: 5 },
      {
        renderVideo: async (call) => {
          renders += 1;
          return renders === 1
            ? { success: false, error: "No available channel (HTTP 503) no live gateway channel" }
            : { success: true, video: clip, model: call.model };
        },
      },
    );
    expect(renders).toBe(2);
  });
});
