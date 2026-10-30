import { useEffect, useRef, useState } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import type { FileClient } from "../../services/files/client";
import type { BinaryPreview } from "./use-workspace";
import { imageLimit, safeImageBlob } from "./preview-utils";

export function ImagePreview({
  client,
  preview,
}: {
  client: FileClient;
  preview: BinaryPreview;
}) {
  const [url, setURL] = useState(""),
    [error, setError] = useState(""),
    [scale, setScale] = useState(1);
  const viewport = useRef<HTMLDivElement>(null),
    drag = useRef<{ x: number; y: number; left: number; top: number } | null>(
      null,
    );
  useEffect(() => {
    let canceled = false,
      objectURL = "";
    setURL("");
    setError("");
    setScale(1);
    void (async () => {
      try {
        const result = await client.readBytes(
          preview.path,
          preview.version,
          imageLimit,
        );
        const blob = await safeImageBlob(result.bytes);
        if (canceled) return;
        objectURL = URL.createObjectURL(blob);
        setURL(objectURL);
      } catch (e) {
        if (!canceled) setError((e as Error).message);
      }
    })();
    return () => {
      canceled = true;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [client, preview.path, preview.version]);
  return (
    <div className="media-viewer">
      <div className="media-toolbar">
        <span>图片预览</span>
        <button
          onClick={() => setScale((v) => Math.max(0.25, v / 1.25))}
          aria-label="缩小图片"
        >
          <Minus size={14} />
        </button>
        <span>{Math.round(scale * 100)}%</span>
        <button
          onClick={() => setScale((v) => Math.min(4, v * 1.25))}
          aria-label="放大图片"
        >
          <Plus size={14} />
        </button>
        <button onClick={() => setScale(1)} aria-label="适应窗口">
          <Maximize size={14} />
        </button>
      </div>
      {error ? (
        <div className="workbench-empty">{error}</div>
      ) : !url ? (
        <div className="workbench-empty">正在读取图片…</div>
      ) : (
        <div
          className="image-viewport"
          ref={viewport}
          onPointerDown={(e) => {
            if (e.button !== 0 || !viewport.current) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = {
              x: e.clientX,
              y: e.clientY,
              left: viewport.current.scrollLeft,
              top: viewport.current.scrollTop,
            };
          }}
          onPointerMove={(e) => {
            if (!drag.current || !viewport.current) return;
            viewport.current.scrollLeft =
              drag.current.left + drag.current.x - e.clientX;
            viewport.current.scrollTop =
              drag.current.top + drag.current.y - e.clientY;
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <img
            src={url}
            alt={preview.path}
            draggable={false}
            style={{ maxWidth: "none", width: `${scale * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
