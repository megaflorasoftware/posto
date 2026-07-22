export type FileDropHandler = (paths: string[]) => void;

type Registration = { handler: FileDropHandler; priority: number; sequence: number };

/** Priority router kept separate from the native listener for deterministic tests. */
export function createFileDropRouter() {
  const registrations: Registration[] = [];
  let sequence = 0;
  return {
    get size() {
      return registrations.length;
    },
    register(handler: FileDropHandler, priority: number): () => void {
      const registration = { handler, priority, sequence: sequence++ };
      registrations.push(registration);
      return () => {
        const index = registrations.indexOf(registration);
        if (index >= 0) registrations.splice(index, 1);
      };
    },
    dispatch(paths: string[]): void {
      registrations
        .reduce<Registration | null>(
          (best, candidate) =>
            !best ||
            candidate.priority > best.priority ||
            (candidate.priority === best.priority && candidate.sequence > best.sequence)
              ? candidate
              : best,
          null,
        )
        ?.handler(paths);
    },
  };
}
