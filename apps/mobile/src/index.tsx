import "@mantine/core/styles.css";
import "@mantine/tiptap/styles.css";
import "@mantine/spotlight/styles.css";
import "@posto/editor/styles.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./App.css";

async function start() {
  if (!("__TAURI_INTERNALS__" in window) && import.meta.env.VITE_POSTO_MOCK === "true") {
    const { installMockBackend } = await import("@posto/ipc/mock");
    installMockBackend();
  }
  createRoot(document.getElementById("root") as HTMLElement).render(<App />);
}

void start();
