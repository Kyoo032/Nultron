/**
 * The inbox store bound to the app database, the way `channelStore()` and `deskFileStore()` are.
 * `store.ts` holds the logic and takes the database as an argument, so a test hands it a scratch one.
 *
 * Importing this module opens the app database (it reaches `@agentforge/db`).
 */
import { sql } from "@agentforge/db";
import { createInboxStore, type InboxStore } from "./store";

let defaultStore: InboxStore | null = null;

export function inboxStore(): InboxStore {
  if (!defaultStore) {
    defaultStore = createInboxStore(sql);
  }
  return defaultStore;
}
