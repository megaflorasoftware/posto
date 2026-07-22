import { createRoot } from "react-dom/client";
import App from "./App";

async function start() {
  if (!("__TAURI_INTERNALS__" in window) && import.meta.env.VITE_POSTO_MOCK === "true") {
    const { installMockBackend } = await import("@posto/ipc/mock");
    installMockBackend();
  }
  createRoot(document.getElementById("root") as HTMLElement).render(<App />);
}

void start();
