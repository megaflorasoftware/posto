import { useEffect, useRef, useState } from "react";
import { invoke } from "@posto/ipc";
import type { FileGroup } from "@posto/ipc";
import { routeForFile } from "../routing";
import type { ServerStatus } from "./useDevServer";

type Options = {
  server: ServerStatus;
  serverRef: React.MutableRefObject<ServerStatus>;
  groupsRef: React.MutableRefObject<FileGroup[]>;
  filePathRef: React.MutableRefObject<string | null>;
  /** Opens the file matching a route the user navigated to in the preview. */
  onRouteOpened: (path: string) => void;
};

/** The preview iframe's routing (forward guesses from the open file, reverse
 * sync from the dev server's log) and the split-pane drag. Desktop-only. */
export function usePreview(options: Options) {
  const { server } = options;
  const [previewRoute, setPreviewRoute] = useState("/");
  // The route the dev server actually served last (from get_last_route), as
  // opposed to previewRoute, which is a forward guess from the open file.
  const [servedRoute, setServedRoute] = useState<string | null>(null);
  // While the split divider is being dragged, the preview iframe must not
  // receive pointer events or it swallows the drag mid-motion.
  const [dragging, setDragging] = useState(false);
  const [split, setSplit] = useState(33);

  const previewRouteRef = useRef(previewRoute);
  previewRouteRef.current = previewRoute;
  const opts = useRef(options);
  opts.current = options;

  const previewFrame = useRef<HTMLIFrameElement | null>(null);
  const lastNavigatedRoute = useRef<string | undefined>(undefined);
  const lastServedRoute = useRef<string | null>(null);
  const panesEl = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stopDragging = () => setDragging(false);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    return () => {
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, []);

  // Fresh server → fresh iframe; forget the last navigation so the effect
  // below issues the initial load.
  useEffect(() => {
    if (server.state === "running") lastNavigatedRoute.current = undefined;
  }, [server]);

  // Navigate the preview imperatively, and only when the target route truly
  // changes. Saves and unrelated re-renders never touch the iframe — content
  // updates are the dev server's job (hot reload).
  useEffect(() => {
    if (server.state !== "running" || !previewFrame.current) return;
    if (previewRoute === lastNavigatedRoute.current) return;
    lastNavigatedRoute.current = previewRoute;
    previewFrame.current.src = `http://localhost:${server.port}${previewRoute}`;
  }, [server, previewRoute]);

  // Whether the dev server actually serves a route. `assumeWhenDown` decides
  // the answer while the server isn't up yet: certain (src/pages file-based)
  // routes are assumed servable so the preview can point at them before the
  // server boots, while uncertain collection guesses are not — an unverified
  // guess must never move the preview.
  async function routeServes(route: string, assumeWhenDown: boolean): Promise<boolean> {
    if (opts.current.serverRef.current.state !== "running") return assumeWhenDown;
    try {
      await invoke("fetch_page", { route });
      return true;
    } catch {
      return false;
    }
  }

  /** Forward navigation: point the preview at the route the opened file
   * implies, but only when we're sure it exists. A content entry's guessed
   * route (e.g. /weeks/2026-29 for a file the site renders at /2026/29) is
   * only trusted once the running dev server confirms it serves; a wrong
   * guess 404s and the preview is left where it is. */
  async function navigateForFile(path: string, content: string) {
    const match = routeForFile(path, content);
    if (!match || match.route === previewRouteRef.current) return;
    if (!(await routeServes(match.route, match.certain))) return;
    // Bail if the user already opened another file during the check.
    if (opts.current.filePathRef.current === path) setPreviewRoute(match.route);
  }

  // Reverse routing: the iframe is cross-origin, so its URL is unreadable —
  // but the dev server logs every page it serves, and the backend tracks the
  // last one. Poll it and react only when the served route *changes*
  // (steady-state values are ignored, so this can't fight with forward
  // navigation or repeat stale routes). Polling, not iframe load events:
  // WebKit doesn't reliably re-fire load for navigations inside the frame.
  function fileForRoute(route: string): string | null {
    for (const group of opts.current.groupsRef.current) {
      for (const file of group.files) {
        if (routeForFile(file.path, "")?.route === route) return file.path;
      }
    }
    return null;
  }

  // Reverse-route polling lives in an effect (not an imperative helper) so
  // each dev-server start gets a fresh interval running current code, cleaned
  // up automatically when the server changes or the app unmounts.
  useEffect(() => {
    if (server.state !== "running") return;
    lastServedRoute.current = null;
    setServedRoute(null);
    const timer = setInterval(async () => {
      const route = await invoke<string | null>("get_last_route");
      if (route === lastServedRoute.current) return;
      lastServedRoute.current = route;
      if (route) setServedRoute(route);
      if (!route || route === previewRouteRef.current) return;
      // The user navigated inside the preview: sync route state without
      // re-navigating the iframe, and select the matching file.
      lastNavigatedRoute.current = route;
      setPreviewRoute(route);
      const file = fileForRoute(route);
      if (file) opts.current.onRouteOpened(file);
    }, 700);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  function onDividerPointerMove(e: React.PointerEvent) {
    if (!dragging || !panesEl.current) return;
    const rect = panesEl.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setSplit(Math.min(85, Math.max(15, pct)));
  }

  /** Back to "/" when a different site is opened. */
  function resetRoute() {
    setPreviewRoute("/");
  }

  return {
    previewRoute,
    servedRoute,
    previewFrame,
    panesEl,
    split,
    dragging,
    setDragging,
    onDividerPointerMove,
    navigateForFile,
    resetRoute,
  };
}
