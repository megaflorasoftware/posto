import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { thumbnailUrl } from "@posto/ipc";

export function useThumbnailUrl(
  path: string | null | undefined,
  fallbackSrc: string | null = null,
  maxWidth = 320,
  maxHeight = 240,
): string | null {
  const key = `${path ?? ""}:${fallbackSrc ?? ""}:${maxWidth}:${maxHeight}`;
  const [resolved, setResolved] = useState<{ key: string; src: string | null }>({ key, src: null });

  useEffect(() => {
    let cancelled = false;
    if (!path) {
      setResolved({ key, src: fallbackSrc });
      return;
    }
    setResolved({ key, src: null });
    void thumbnailUrl(path, maxWidth, maxHeight).then((src) => {
      if (!cancelled) setResolved({ key, src: src ?? fallbackSrc });
    });
    return () => {
      cancelled = true;
    };
  }, [key, path, fallbackSrc, maxWidth, maxHeight]);

  return resolved.key === key ? resolved.src : null;
}

export function CachedImage(props: Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  path: string | null | undefined;
  fallback?: ReactNode;
  fallbackSrc?: string | null;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
}) {
  const {
    path,
    fallback = null,
    fallbackSrc = null,
    thumbnailWidth = 320,
    thumbnailHeight = 240,
    onError,
    ...imageProps
  } = props;
  const src = useThumbnailUrl(path, fallbackSrc, thumbnailWidth, thumbnailHeight);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!src || failedSrc === src) return fallback;
  return (
    <img
      {...imageProps}
      src={src}
      decoding={imageProps.decoding ?? "async"}
      onError={(event) => {
        setFailedSrc(src);
        onError?.(event);
      }}
    />
  );
}
