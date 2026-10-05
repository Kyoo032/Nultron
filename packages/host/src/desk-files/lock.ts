const tails = new Map<string, Promise<void>>();

/**
 * Run `task` after every earlier task for the same desk has finished.
 *
 * A save reads the file's head version, writes a sealed object, then commits the rows, and the
 * object write is asynchronous. Two saves of one path in flight would both read version N and both
 * claim N+1. The host is one process (SQLite, one writer), so a queue per desk is enough; the
 * primary key on `(file_id, version)` stays as the backstop if that ever stops being true.
 */
export async function withDeskLock<T>(deskId: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(deskId) ?? Promise.resolve();
  let release: () => void = () => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(deskId, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (tails.get(deskId) === tail) {
      tails.delete(deskId);
    }
  }
}
