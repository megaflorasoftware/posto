import { expect, test, vi } from "vitest";
import { createFileDropRouter } from "../../ipc/src/fileDropRouter";
import { droppedImageDirectory } from "../src/droppedImages";

test("routes drops to the highest priority regardless of mount order", () => {
  const router = createFileDropRouter();
  const modal = vi.fn();
  const app = vi.fn();
  const removeModal = router.register(modal, 100);
  const removeApp = router.register(app, 0);

  router.dispatch(["photo.jpg"]);
  expect(modal).toHaveBeenCalledWith(["photo.jpg"], { pointer: null });
  expect(app).not.toHaveBeenCalled();

  removeModal();
  router.dispatch(["next.jpg"]);
  expect(app).toHaveBeenCalledWith(["next.jpg"], { pointer: null });
  removeApp();
  expect(router.size).toBe(0);
});

test("breaks equal-priority ties by most recent registration", () => {
  const router = createFileDropRouter();
  const first = vi.fn();
  const second = vi.fn();
  router.register(first, 10);
  router.register(second, 10);

  router.dispatch(["photo.jpg"]);
  expect(second).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
});

test("routes a positioned drop to the highest-priority accepting surface", () => {
  const router = createFileDropRouter();
  const editor = vi.fn();
  const app = vi.fn();
  router.register(editor, 50, (_paths, details) => (details.pointer?.x ?? 0) < 500);
  router.register(app, 0);

  router.dispatch(["inside.jpg"], { pointer: { x: 240, y: 320 } });
  expect(editor).toHaveBeenCalledWith(["inside.jpg"], { pointer: { x: 240, y: 320 } });
  expect(app).not.toHaveBeenCalled();

  router.dispatch(["outside.jpg"], { pointer: { x: 840, y: 320 } });
  expect(app).toHaveBeenCalledWith(["outside.jpg"], { pointer: { x: 840, y: 320 } });
});

test("resolves image drops only to directories inside the active media root", () => {
  const target = (path: string) => () =>
    ({
      closest: () => ({ getAttribute: () => path }),
    }) as never;

  expect(
    droppedImageDirectory(
      ["/tmp/portrait.jpg", "/tmp/notes.txt"],
      { x: 20, y: 40 },
      "/repo/media",
      target("/repo/media/portraits"),
    ),
  ).toBe("/repo/media/portraits");
  expect(
    droppedImageDirectory(
      ["/tmp/portrait.jpg"],
      { x: 20, y: 40 },
      "/repo/media",
      target("/repo/public"),
    ),
  ).toBeNull();
  expect(
    droppedImageDirectory(
      ["/tmp/notes.txt"],
      { x: 20, y: 40 },
      "/repo/media",
      target("/repo/media/portraits"),
    ),
  ).toBeNull();
});

test("prefers a directory card and falls back to the open media pane directory", () => {
  const target = (path?: string) => () =>
    ({
      closest: () => (path ? { getAttribute: () => path } : null),
    }) as never;
  const fallback = {
    directory: "/repo/media/open",
    contains: (x: number, y: number) => x >= 0 && x <= 300 && y >= 0 && y <= 600,
  };

  expect(
    droppedImageDirectory(
      ["/tmp/portrait.jpg"],
      { x: 20, y: 40 },
      "/repo/media",
      target("/repo/media/open/portraits"),
      fallback,
    ),
  ).toBe("/repo/media/open/portraits");
  expect(
    droppedImageDirectory(
      ["/tmp/portrait.jpg"],
      { x: 20, y: 40 },
      "/repo/media",
      target(),
      fallback,
    ),
  ).toBe("/repo/media/open");
  expect(
    droppedImageDirectory(
      ["/tmp/portrait.jpg"],
      { x: 500, y: 40 },
      "/repo/media",
      target(),
      fallback,
    ),
  ).toBeNull();
});
