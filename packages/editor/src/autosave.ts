export const AUTOSAVE_DELAY_MS = 800;

const pendingSaves = new Set<() => Promise<void>>();

/** Lets an editor with its own autosave timer be flushed before a publish or
 * sync reads the working tree. Returns the unregister function. */
export function registerPendingSave(flush: () => Promise<void>): () => void {
  pendingSaves.add(flush);
  return () => {
    pendingSaves.delete(flush);
  };
}

export async function flushRegisteredSaves(): Promise<void> {
  await Promise.all([...pendingSaves].map((flush) => flush()));
}
