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

  if (error) {
    return (
      <div className="flex size-20 items-center justify-center rounded-lg border border-border bg-raised text-[11px] text-text-dimmed">
        Failed to load
      </div>
    );
  }

  if (!src) {
    return (
      <div className="size-20 animate-pulse rounded-lg border border-border bg-raised" />
    );
  }

  return (
    <>
      <img
        src={src}
        alt=""
        className="max-h-48 max-w-xs cursor-pointer rounded-lg border border-border object-cover transition-opacity hover:opacity-90"
        onClick={() => setExpanded(true)}
      />
      {expanded && (
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
