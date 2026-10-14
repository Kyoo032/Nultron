export type TextPart = {
  type: "text";
  text: string;
};

export type ImageUrlPart = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
};

export type VideoUrlPart = {
  type: "video_url";
  video_url: {
    url: string;
  };
};

/** Assistant-only: chain-of-thought. Never accepted on user run input. */
export type ThinkingPart = {
  type: "thinking";
  text: string;
};

/** Assistant-only: a tool call in the transcript. Never accepted on user run input. */
export type ToolCallPart = {
  type: "tool_call";
  toolKey: string;
  status: "started" | "completed";
  input?: unknown;
  output?: unknown;
};

/**
 * Assistant-only. The host writes this when the turn stopped at the step limit.
 * The renderer shows Continue from this part and does not match the sentence.
 * Never accepted on user run input.
 */
export type StepLimitPart = {
  type: "step_limit";
  /** Tool keys that finished before the limit, in the order they finished. */
  tools: string[];
};

export type ContentPart = TextPart | ImageUrlPart | VideoUrlPart | ThinkingPart | ToolCallPart | StepLimitPart;

export type RunInputBody = {
  content?: unknown;
  stream?: unknown;
};
