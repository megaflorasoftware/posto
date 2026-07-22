import { expect, test, vi } from "vitest";
import { createFileDropRouter } from "../../ipc/src/fileDropRouter";

test("routes drops to the highest priority regardless of mount order", () => {
  const router = createFileDropRouter();
  const modal = vi.fn();
  const app = vi.fn();
  const removeModal = router.register(modal, 100);
  const removeApp = router.register(app, 0);

  router.dispatch(["photo.jpg"]);
  expect(modal).toHaveBeenCalledWith(["photo.jpg"]);
  expect(app).not.toHaveBeenCalled();

  removeModal();
  router.dispatch(["next.jpg"]);
  expect(app).toHaveBeenCalledWith(["next.jpg"]);
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
