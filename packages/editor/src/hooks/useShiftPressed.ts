import { useEffect, useState } from "react";

/** Tracks Shift while this browser surface is mounted. */
export function useShiftPressed(): boolean {
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") setPressed(true);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") setPressed(false);
    };
    const reset = () => setPressed(false);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", reset);
    };
  }, []);

  return pressed;
}
