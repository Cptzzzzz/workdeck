import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import type { FileClient } from "../../services/files/client";
import { MAX_CHUNK } from "../../services/files/protocol";
import type { BinaryPreview } from "./use-workspace";
import {
  readPDFView,
  writePDFView,
  type PDFViewState,
} from "../../services/files/view-state";

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
    [viewError, setViewError] = useState(""),
    [width, setWidth] = useState(600);
  const viewport = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<PDFViewState>({
    page: 1,
    zoom: 1,
    scrollTop: 0,
    scrollLeft: 0,
  });
  const viewReady = useRef(false),
    scrollRestored = useRef(false),
    mounted = useRef(true),
    scrollTimer = useRef(0);
  const persistView = () => {
    if (!viewReady.current) return;
    void writePDFView(preview.identity, view.current)
      .then(() => {
        if (mounted.current) setViewError("");
      })
      .catch((e) => {
        if (mounted.current) setViewError((e as Error).message);
      });
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    };
  }, []);
  useEffect(() => {
    let canceled = false,
      readID = "",
      task: pdfjs.PDFDocumentLoadingTask | undefined,
      range: FileRange | undefined;
    setPDF(null);
    setPage(1);
    setZoom(1);
    setError("");
    viewReady.current = false;
    scrollRestored.current = false;
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
        let restored: PDFViewState | undefined;
        try {
          restored = await readPDFView(preview.identity);
        } catch (e) {
          if (!canceled) setViewError((e as Error).message);
        }
        if (canceled) return;
        view.current = restored || {
          page: 1,
          zoom: 1,
          scrollTop: 0,
          scrollLeft: 0,
        };
        setPage(view.current.page);
        setZoom(view.current.zoom);
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
        if (!canceled) {
          view.current.page = Math.min(view.current.page, loaded.numPages);
          setPage(view.current.page);
          setPDF(loaded);
        } else void loaded.destroy().catch(() => {});
      } catch (e) {
        fail(e as Error);
      }
    })();
    return () => {
      canceled = true;
      if (scrollTimer.current) {
        clearTimeout(scrollTimer.current);
        scrollTimer.current = 0;
      }
      persistView();
      viewReady.current = false;
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
        const renderView = item.getViewport({ scale }),
          target = canvas.current;
        if (!target) return;
        target.width = Math.ceil(renderView.width);
        target.height = Math.ceil(renderView.height);
        const context = target.getContext("2d");
        if (!context) throw new Error("浏览器无法渲染 PDF");
        render = item.render({ canvasContext: context, viewport: renderView });
        await render.promise;
        if (!canceled && !scrollRestored.current && viewport.current) {
          viewport.current.scrollTop = view.current.scrollTop;
          viewport.current.scrollLeft = view.current.scrollLeft;
          scrollRestored.current = true;
          viewReady.current = true;
          persistView();
        }
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
  const changePage = (next: number) => {
    view.current.page = next;
    setPage(next);
    persistView();
  };
  const changeZoom = (next: number) => {
    view.current.zoom = next;
    setZoom(next);
    persistView();
  };
  return (
    <div className="media-viewer">
      <div className="media-toolbar">
        <span>PDF 预览</span>
        <button
          aria-label="上一页"
          disabled={!pdf || page <= 1}
          onClick={() => changePage(page - 1)}
        >
          <ChevronLeft size={14} />
        </button>
        <span>{pdf ? `${page} / ${pdf.numPages}` : "加载中"}</span>
        <button
          aria-label="下一页"
          disabled={!pdf || page >= pdf.numPages}
          onClick={() => changePage(page + 1)}
        >
          <ChevronRight size={14} />
        </button>
        <button
          aria-label="缩小 PDF"
          disabled={!pdf}
          onClick={() => changeZoom(Math.max(0.5, zoom / 1.25))}
        >
          <Minus size={14} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          aria-label="放大 PDF"
          disabled={!pdf}
          onClick={() => changeZoom(Math.min(3, zoom * 1.25))}
        >
          <Plus size={14} />
        </button>
      </div>
      {viewError && (
        <div className="workbench-notice">
          PDF 视图无法持久保存：{viewError}
        </div>
      )}
      <div
        className="pdf-viewport"
        ref={viewport}
        onScroll={() => {
          if (!viewReady.current || !viewport.current) return;
          view.current.scrollTop = viewport.current.scrollTop;
          view.current.scrollLeft = viewport.current.scrollLeft;
          if (scrollTimer.current) clearTimeout(scrollTimer.current);
          scrollTimer.current = window.setTimeout(() => {
            scrollTimer.current = 0;
            persistView();
          }, 200);
        }}
      >
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
