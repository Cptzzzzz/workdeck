import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import type { FileClient } from "../../services/files/client";
import { MAX_CHUNK } from "../../services/files/protocol";
import type { BinaryPreview } from "./use-workspace";

pdfjs.GlobalWorkerOptions.workerSrc = workerURL;
const MAX_PDF = 100 * 1024 * 1024,
  MAX_RANGE = 2 * 1024 * 1024;
class FileRange extends pdfjs.PDFDataRangeTransport {
  private closed = false;
  private pending = 0;
  constructor(
    length: number,
    private client: FileClient,
    private readID: string,
    private onError: (error: Error) => void,
  ) {
    super(length, null);
  }
  requestDataRange(begin: number, end: number): void {
    if (this.closed) return;
    if (
      !Number.isSafeInteger(begin) ||
      !Number.isSafeInteger(end) ||
      begin < 0 ||
      end <= begin ||
      end > this.length ||
      end - begin > MAX_RANGE ||
      this.pending >= 32
    ) {
      this.onError(new Error("PDF 读取范围无效或请求过多"));
      return;
    }
    this.pending++;
    void (async () => {
      try {
        const data = new Uint8Array(end - begin);
        for (let offset = begin; offset < end; ) {
          if (this.closed) return;
          const chunk = await this.client.readChunk(
            this.readID,
            offset,
            Math.min(MAX_CHUNK, end - offset),
          );
          if (!chunk.length) throw new Error("PDF 文件读取提前结束");
          data.set(chunk, offset - begin);
          offset += chunk.length;
        }
        if (!this.closed) this.onDataRange(begin, data);
      } catch (error) {
        if (!this.closed) this.onError(error as Error);
      } finally {
        this.pending--;
      }
    })();
  }
  abort(): void {
    this.closed = true;
  }
}
export function PDFPreview({
  client,
  preview,
}: {
  client: FileClient;
  preview: BinaryPreview;
}) {
  const [pdf, setPDF] = useState<pdfjs.PDFDocumentProxy | null>(null),
    [page, setPage] = useState(1),
    [zoom, setZoom] = useState(1),
    [error, setError] = useState(""),
    [width, setWidth] = useState(600);
  const viewport = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let canceled = false,
      readID = "",
      task: pdfjs.PDFDocumentLoadingTask | undefined,
      range: FileRange | undefined;
    setPDF(null);
    setPage(1);
    setZoom(1);
    setError("");
    const fail = (error: Error) => {
      if (canceled) return;
      setError(error.message || "无法读取 PDF");
      range?.abort();
      void task?.destroy().catch(() => {});
      if (readID) {
        const handle = readID;
        readID = "";
        void client.closeRead(handle).catch(() => {});
      }
    };
    void (async () => {
      try {
        if (
          !Number.isSafeInteger(preview.size) ||
          preview.size < 1 ||
          preview.size > MAX_PDF
        )
          throw new Error("PDF 超过 100 MiB 预览限制");
        const opened = await client.openRead(preview.path, preview.version);
        readID = opened.id;
        if (canceled) {
          await client.closeRead(readID).catch(() => {});
          return;
        }
        if (opened.entry.size !== preview.size)
          throw new Error("PDF 文件已改变，请重新打开");
        range = new FileRange(preview.size, client, readID, fail);
        task = pdfjs.getDocument({
          range,
          length: preview.size,
          rangeChunkSize: 65536,
          disableStream: true,
          disableAutoFetch: true,
          isEvalSupported: false,
          enableXfa: false,
          maxImageSize: 32 * 1024 * 1024,
          canvasMaxAreaInBytes: 64 * 1024 * 1024,
          useSystemFonts: true,
          standardFontDataUrl: new URL(
            "/assets/pdfjs/standard_fonts/",
            location.origin,
          ).href,
          cMapUrl: new URL("/assets/pdfjs/cmaps/", location.origin).href,
          cMapPacked: true,
        });
        const loaded = await task.promise;
        if (!canceled) setPDF(loaded);
        else void loaded.destroy().catch(() => {});
      } catch (e) {
        fail(e as Error);
      }
    })();
    return () => {
      canceled = true;
      range?.abort();
      void task?.destroy().catch(() => {});
      if (readID) void client.closeRead(readID).catch(() => {});
    };
  }, [client, preview.path, preview.version, preview.size]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let canceled = false,
      render: pdfjs.RenderTask | undefined;
    if (!pdf || !canvas.current) return;
    void (async () => {
      try {
        const item = await pdf.getPage(page);
        if (canceled) return;
        const base = item.getViewport({ scale: 1 });
        const fit = Math.max(0.1, Math.min(2, (width - 40) / base.width));
        let scale = fit * zoom;
        if (base.width * base.height * scale * scale > 16 * 1024 * 1024)
          scale = Math.sqrt((16 * 1024 * 1024) / (base.width * base.height));
        const view = item.getViewport({ scale }),
          target = canvas.current;
        if (!target) return;
        target.width = Math.ceil(view.width);
        target.height = Math.ceil(view.height);
        const context = target.getContext("2d");
        if (!context) throw new Error("浏览器无法渲染 PDF");
        render = item.render({ canvasContext: context, viewport: view });
        await render.promise;
      } catch (e) {
        if (!canceled && (e as Error).name !== "RenderingCancelledException")
          setError((e as Error).message || "PDF 页面渲染失败");
      }
    })();
    return () => {
      canceled = true;
      render?.cancel();
    };
  }, [pdf, page, zoom, width]);
  return (
    <div className="media-viewer">
      <div className="media-toolbar">
        <span>PDF 预览</span>
        <button
          aria-label="上一页"
          disabled={!pdf || page <= 1}
          onClick={() => setPage((n) => n - 1)}
        >
          <ChevronLeft size={14} />
        </button>
        <span>{pdf ? `${page} / ${pdf.numPages}` : "加载中"}</span>
        <button
          aria-label="下一页"
          disabled={!pdf || page >= pdf.numPages}
          onClick={() => setPage((n) => n + 1)}
        >
          <ChevronRight size={14} />
        </button>
        <button
          aria-label="缩小 PDF"
          onClick={() => setZoom((n) => Math.max(0.5, n / 1.25))}
        >
          <Minus size={14} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          aria-label="放大 PDF"
          onClick={() => setZoom((n) => Math.min(3, n * 1.25))}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="pdf-viewport" ref={viewport}>
        {error ? (
          <div className="workbench-empty">{error}</div>
        ) : (
          <>
            <canvas ref={canvas} aria-label="PDF 页面" />
            {!pdf && <div className="workbench-empty">正在读取 PDF…</div>}
          </>
        )}
      </div>
    </div>
  );
}
