import { type LanguageModel, wrapLanguageModel } from "ai";

type StreamPart = Awaited<ReturnType<LanguageModel["doStream"]>>["stream"] extends ReadableStream<infer Part> ? Part : never;

export function openReasoningBeforeSignature(): TransformStream<StreamPart, StreamPart> {
  let reasoningOpen = false;
  return new TransformStream<StreamPart, StreamPart>({
    transform(part, controller) {
      if (part.type === "reasoning") {
        reasoningOpen = true;
      }
      if (part.type === "reasoning-signature") {
        if (!reasoningOpen) {
          controller.enqueue({ type: "reasoning", textDelta: "" });
        }
        reasoningOpen = false;
      }
      controller.enqueue(part);
    },
  });
}

export function withSignedReasoning(model: LanguageModel): LanguageModel {
  return wrapLanguageModel({
    model,
    middleware: {
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        return { ...result, stream: result.stream.pipeThrough(openReasoningBeforeSignature()) };
      },
    },
  });
}
