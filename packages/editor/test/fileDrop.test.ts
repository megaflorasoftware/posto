import { expect, test, vi } from "vitest";
import { createFileDropRouter } from "../../ipc/src/fileDropRouter";

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
