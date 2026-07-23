import { createContext, useContext, type ReactNode } from "react";
import { invoke } from "@posto/ipc";
import type { ProjectIO } from "@posto/core/project/adapter";

/** Native project IO used by the app shells and supplied to editor trees. */
export const ipcProjectIO: ProjectIO = {
  async pathExists(path, kind) {
    return invoke<boolean>("path_exists", { path, kind });
  },
  readTextFileOptional(path) {
    return invoke<string | null>("read_text_file_optional", { path });
  },
  listDirFilesOptional(dir, extensions) {
    return invoke<{ name: string; path: string }[] | null>("list_dir_files_optional", {
      dir,
      extensions,
    });
  },
};

const ProjectIOContext = createContext<ProjectIO | null>(null);

export function ProjectIOProvider(props: { value: ProjectIO; children: ReactNode }) {
  return (
    <ProjectIOContext.Provider value={props.value}>{props.children}</ProjectIOContext.Provider>
  );
}

export function useProjectIO(): ProjectIO {
  const io = useContext(ProjectIOContext);
  if (!io) throw new Error("ProjectIOProvider is missing from the editor tree");
  return io;
}
