import { imagePrompt, imageShape } from "@agentforge/core";

export type ImageAspect = "square" | "landscape" | "portrait";
export type VideoAspect = "16:9" | "9:16" | "1:1";
export type VideoResolution = "480p" | "720p" | "1080p";

export type StoredImageRequest = {
  readonly kind: "image";
  readonly prompt: string;
  readonly aspect: ImageAspect;
  readonly model: string;
  readonly imageUrl?: string;
};

export type StoredVideoRequest = {
  readonly kind: "video";
  readonly prompt: string;
  readonly aspect: VideoAspect;
  readonly model: string;
  readonly imageUrl?: string;
  readonly seconds?: number;
  readonly resolution?: VideoResolution;
};

export type StoredMediaRequest = StoredImageRequest | StoredVideoRequest;

export type ImageToolArgs = {
  readonly prompt: string;
  readonly aspect_ratio?: ImageAspect;
  readonly size?: Parameters<typeof imageShape>[0];
  readonly style?: Parameters<typeof imagePrompt>[1];
  readonly image_url?: string;
  readonly model?: string;
};

export type VideoToolArgs = {
  readonly prompt: string;
  readonly aspect_ratio?: VideoAspect;
  readonly image_url?: string;
  readonly model?: string;
  readonly seconds?: number;
  readonly resolution?: VideoResolution;
};

export function imageRequestFrom(args: ImageToolArgs, defaultModel: string): StoredImageRequest {
  return {
    kind: "image",
    prompt: imagePrompt(args.prompt, args.style),
    aspect: imageShape(args.size, args.aspect_ratio),
    model: args.model || defaultModel,
    ...(args.image_url ? { imageUrl: args.image_url } : {}),
  };
}

export function videoRequestFrom(args: VideoToolArgs, defaultModel: string): StoredVideoRequest {
  return {
    kind: "video",
    prompt: args.prompt,
    aspect: args.aspect_ratio ?? "16:9",
    model: args.model || defaultModel,
    ...(args.image_url ? { imageUrl: args.image_url } : {}),
    ...(args.seconds !== undefined ? { seconds: args.seconds } : {}),
    ...(args.resolution ? { resolution: args.resolution } : {}),
  };
}
