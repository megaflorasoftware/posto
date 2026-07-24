export interface FileDropDetails {
  pointer: { x: number; y: number } | null;
}

export type FileDropHandler = (paths: string[], details: FileDropDetails) => void;
export type FileDropAcceptance = (paths: string[], details: FileDropDetails) => boolean;

type Registration = {
  handler: FileDropHandler;
  accepts?: FileDropAcceptance;
  priority: number;
  sequence: number;
};

/** Priority router kept separate from the native listener for deterministic tests. */
export function createFileDropRouter() {
  const registrations: Registration[] = [];
  let sequence = 0;
  return {
    get size() {
      return registrations.length;
    },
    register(handler: FileDropHandler, priority: number, accepts?: FileDropAcceptance): () => void {
      const registration = { handler, accepts, priority, sequence: sequence++ };
      registrations.push(registration);
      return () => {
        const index = registrations.indexOf(registration);
        if (index >= 0) registrations.splice(index, 1);
      };
    },
    dispatch(paths: string[], details: FileDropDetails = { pointer: null }): void {
      registrations
        .filter((registration) => registration.accepts?.(paths, details) ?? true)
        .reduce<Registration | null>(
          (best, candidate) =>
            !best ||
            candidate.priority > best.priority ||
            (candidate.priority === best.priority && candidate.sequence > best.sequence)
              ? candidate
              : best,
          null,
        )
        ?.handler(paths, details);
    },
  };
}
