import { downloadArtifactFile } from "@/lib/artifacts-client";

export type ChatFileSaveResult = { readonly ok: true } | { readonly ok: false; readonly reason: string | null };

export async function saveChatFile(
  artifactId: string,
  filename: string,
  save: (artifactId: string, fallbackName: string) => Promise<void> = downloadArtifactFile,
): Promise<ChatFileSaveResult> {
  try {
    await save(artifactId, filename);
    return { ok: true };
  } catch {
    return { ok: false, reason: null };
  }
}
