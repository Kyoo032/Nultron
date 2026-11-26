/** Binds the email channel store to the app database, like `inbox/db.ts`. */
import { sql } from "@agentforge/db";
import { createEmailStore, type EmailStore } from "./store";

let store: EmailStore | null = null;

export function emailStore(): EmailStore {
  if (!store) {
    store = createEmailStore(sql);
  }
  return store;
}
