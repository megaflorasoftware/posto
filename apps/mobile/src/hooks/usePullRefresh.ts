import { useRef, useState, type TouchEvent as ReactTouchEvent } from "react";

const PULL_REFRESH_THRESHOLD = 60;

export function usePullRefresh(onRefresh: () => void | Promise<void>) {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  async function refresh() {
    setRefreshing(true);
    try {
      await refreshRef.current();
    } finally {
      setRefreshing(false);
    }
  }

  function onTouchStart(event: ReactTouchEvent) {
    if (refreshing || (viewportRef.current?.scrollTop ?? 1) > 0) return;
    startY.current = event.touches[0].clientY;
  }

  function onTouchMove(event: ReactTouchEvent) {
    if (startY.current === null) return;
    if ((viewportRef.current?.scrollTop ?? 0) > 0) {
      startY.current = null;
      setPullDistance(0);
      return;
    }
    const delta = event.touches[0].clientY - startY.current;
    setPullDistance(delta > 0 ? Math.min(delta / 2, 90) : 0);
  }

  function onTouchEnd() {
    if (startY.current === null) return;
    startY.current = null;
    if (pullDistance >= PULL_REFRESH_THRESHOLD) void refresh();
    setPullDistance(0);
  }

  return {
    viewportRef,
    pullDistance,
    refreshing,
    progress: Math.min(pullDistance / PULL_REFRESH_THRESHOLD, 1),
    onTouchStart,
    onTouchMove,
    onTouchEnd,
  };
}
