/**
 * Runs the Node.js version check when it is imported (SH-001). `server-env.ts` imports this first,
 * before the hosted guards, so a server started on an old Node stops here, before any native addon
 * (better-sqlite3 through `@agentforge/db`) loads and crashes. Imported for its side effect only;
 * nothing else in `apps/web` should import it.
 */
import { assertSupportedNode } from "./node-version";

assertSupportedNode(process.version);
