/**
 * The address of the audio worklet module (`voice-worklet.ts`).
 *
 * `?worker&url` makes Vite bundle that file by itself, and emit it as `assets/voice-worklet-<hash>.js`
 * in a production build, and gives back its URL. That is a same-origin path, which the host's
 * `script-src 'self'` allows (`packages/host/src/security-headers.ts`). `?worker&inline` would be a
 * `blob:` or `data:` URL, which it does not, so it must never be used for this file.
 *
 * Kept in a file of its own so the test setup, which never builds a worklet, imports nothing that
 * depends on the bundler.
 */
import workletUrl from "./voice-worklet?worker&url";

export const VOICE_WORKLET_URL: string = workletUrl;
