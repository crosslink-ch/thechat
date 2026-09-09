import { useState, useEffect } from "react";
import { loadImageBase64 } from "../lib/images";

interface ImagePart {
  path: string;
  mimeType: string;
}

interface MessageImagesProps {
  images: ImagePart[];
}

function MessageImage({ image }: { image: ImagePart }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadImageBase64(image.path)
      .then((base64) => {
        if (!cancelled) setSrc(`data:${image.mimeType};base64,${base64}`);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => { cancelled = true; };
  }, [image.path, image.mimeType]);

  return (
    <>
      <div
        data-testid="message-image-frame"
        className="aspect-[5/3] w-80 max-w-full shrink-0"
      >
        {error ? (
          <div className="flex h-full w-full items-center justify-center rounded-lg border border-border bg-raised text-[0.786rem] text-text-dimmed">
            Failed to load
          </div>
        ) : src ? (
          <img
            src={src}
            alt=""
            className="h-full w-full cursor-pointer rounded-lg border border-border object-contain transition-opacity hover:opacity-90"
            onClick={() => setExpanded(true)}
          />
        ) : (
          <div className="h-full w-full animate-pulse rounded-lg border border-border bg-raised" />
        )}
      </div>
      {expanded && src && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setExpanded(false)}
        >
          <img
            src={src}
            alt=""
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

export function MessageImages({ images }: MessageImagesProps) {
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {images.map((img, i) => (
        <MessageImage key={i} image={img} />
      ))}
    </div>
  );
}
