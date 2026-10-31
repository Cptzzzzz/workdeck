import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderCog,
  RefreshCw,
  Save,
  Download,
  Plus,
  Upload,
  Pencil,
  Trash2,
  Server,
  Settings2,
  UserRound,
  TerminalSquare,
  X,
} from "lucide-react";
import type {
  WorkspaceController,
  Document,
  ConflictSnapshot,
} from "./use-workspace";
import type { CreateIntent, DraftIdentity } from "../../services/files/drafts";
import { DirectoryPicker } from "../management/forms";
import type { ComputeNode, TerminalRecord } from "../../types";
import type { DeleteStatus, DeleteOutcome } from "../../services/files/types";
import { formatBytes, formatLatency } from "../../network-metrics";
const MonacoEditor = lazy(() =>
  import("./monaco-editor").then((m) => ({ default: m.MonacoEditor })),
);
const ConflictDiff = lazy(() =>
  import("./conflict-diff").then((m) => ({ default: m.ConflictDiff })),
);
const MarkdownPreview = lazy(() =>
  import("./markdown-preview").then((m) => ({ default: m.MarkdownPreview })),
);
const ImagePreview = lazy(() =>
  import("./image-preview").then((m) => ({ default: m.ImagePreview })),
);
const PDFPreview = lazy(() =>
  import("./pdf-preview").then((m) => ({ default: m.PDFPreview })),
);

export function WorkspaceSidebar({
  controller,
  onSessions,
  onNodes,
  onAccount,
  onSettings,
  onNewItem,
  onRename,
  onDelete,
  onChangeRoot,
}: {
  controller: WorkspaceController;
  onSessions: () => void;
  onNodes: () => void;
  onAccount: () => void;
  onSettings: () => void;
  onNewItem: () => void;
  onRename: (path: string) => void;
  onDelete: (
    path: string,
    directory: boolean,
    intent?: (typeof controller.intents)[number],
  ) => void;
  onChangeRoot: () => void;
}) {
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<{
    parent: string;
    workspace: string;
    revision: number;
    intent?: (typeof controller.intents)[number];
  } | null>(null);
  const chooseUpload = (intent?: (typeof controller.intents)[number]) => {
    if (!controller.workspace) return;
    uploadTarget.current = {
      parent: controller.selectedDirectory,
      workspace: controller.workspace.id,
      revision: controller.workspace.root_revision,
      intent,
    };
    uploadInput.current?.click();
  };
  const renderDirectory = (path: string, depth: number): React.ReactNode => {
    const listing = controller.directories[path];
    if (!listing) return null;
    return (
      <>
        {listing.entries.map((entry) => {
          const child = controller.childPath(path, entry.name),
            folder = entry.kind === "directory",
            open = controller.expanded.has(child);
          return (
            <div key={child}>
              <div className="file-tree-entry">
                <button
                  className={
                    "file-tree-row " +
                    (folder && controller.selectedDirectory === child
                      ? "selected-directory"
                      : "")
                  }
                  style={{ paddingLeft: 12 + depth * 15 }}
                  disabled={entry.restricted}
                  title={entry.restricted ? "此文件类型暂不可操作" : child}
                  onClick={() =>
                    void (folder
                      ? controller.toggle(child)
                      : controller.openFile(child))
                  }
                >
                  {folder ? (
                    open ? (
                      <ChevronDown size={13} />
                    ) : (
                      <ChevronRight size={13} />
                    )
                  ) : (
                    <span className="file-tree-spacer" />
                  )}
                  {folder ? <Folder size={15} /> : <File size={15} />}
                  <span>{entry.name}</span>
                </button>
                {!entry.restricted && (folder || entry.kind === "file") && (
                  <button
                    className="file-tree-download"
                    title={`重命名 ${entry.name}`}
                    aria-label={`重命名 ${entry.name}`}
                    disabled={
                      !controller.supportsRename ||
                      controller.renaming ||
                      !controller.fileReady
                    }
                    onClick={() => onRename(child)}
                  >
                    <Pencil size={13} />
                  </button>
                )}
                {!entry.restricted && (folder || entry.kind === "file") && (
                  <button
                    className="file-tree-download"
                    title={`删除 ${entry.name}`}
                    aria-label={`删除 ${entry.name}`}
                    disabled={
                      !controller.supportsDelete ||
                      controller.renaming ||
                      !controller.fileReady
                    }
                    onClick={() => onDelete(child, folder)}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
                {!folder && entry.kind === "file" && !entry.restricted && (
                  <button
                    className="file-tree-download"
                    title={`下载 ${entry.name}`}
                    aria-label={`下载 ${entry.name}`}
                    disabled={!!controller.transfer}
                    onClick={() =>
                      void controller.download(child).catch((e) => {
                        if ((e as Error).name !== "AbortError")
                          controller.reportError((e as Error).message);
                      })
                    }
                  >
                    <Download size={14} />
                  </button>
                )}
              </div>
              {folder && open && renderDirectory(child, depth + 1)}
            </div>
          );
        })}
        {listing.truncated && (
          <div className="file-tree-warning">目录条目过多，显示结果已截断</div>
        )}
      </>
    );
  };
  return (
    <div className="workbench-sidebar">
      <div className="workbench-sidebar-title">
        <span>资源管理器</span>
        <div className="workbench-tree-actions">
          <button
            className="icon-button"
            title="更换工作区目录"
            aria-label="更换工作区目录"
            disabled={
              !controller.workspace ||
              !controller.fileReady ||
              controller.renaming
            }
            onClick={onChangeRoot}
          >
            <FolderCog size={16} />
          </button>
          <input
            ref={uploadInput}
            type="file"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0],
                target = uploadTarget.current;
              event.currentTarget.value = "";
              if (file && target)
                void controller
                  .uploadFile(
                    file,
                    target.parent,
                    target.workspace,
                    target.revision,
                    target.intent,
                  )
                  .catch((e) => {
                    controller.clearTransfer();
                    if ((e as Error).name !== "AbortError")
                      controller.reportError((e as Error).message);
                  });
            }}
          />
          <button
            className="icon-button"
            title="上传文件到所选目录"
            aria-label="上传文件到所选目录"
            disabled={
              !controller.supportsCreate ||
              !controller.workspace ||
              !controller.fileReady ||
              !!controller.transfer
            }
            onClick={() => chooseUpload()}
          >
            <Upload size={16} />
          </button>
          <button
            className="icon-button"
            title={
              controller.supportsCreate
                ? "新建文件或文件夹"
                : "请先升级节点以启用文件创建"
            }
            aria-label="新建文件或文件夹"
            disabled={
              !controller.supportsCreate ||
              !controller.workspace ||
              !controller.fileReady
            }
            onClick={onNewItem}
          >
            <Plus size={16} />
          </button>
          <button
            className="icon-button"
            title="刷新文件树"
            aria-label="刷新文件树"
            onClick={() => void controller.refresh()}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
      {controller.workspace ? (
        <button
          className={
            "workbench-root " +
            (controller.selectedDirectory === "." ? "selected-directory" : "")
          }
          title={controller.workspace.root_path}
          onClick={() => controller.selectDirectory(".")}
        >
          <Folder size={15} />
          <span>{controller.workspace.root_path}</span>
        </button>
      ) : (
        <div className="workbench-hint">选择一个终端以浏览其工作目录</div>
      )}
      <div className="file-tree">{renderDirectory(".", 0)}</div>
      {controller.deletedDrafts.length > 0 && (
        <div className="workbench-intents">
          <b>已删除文件的草稿</b>
          {controller.deletedDrafts.map((d) => (
            <div key={JSON.stringify(d)}>
              <span title={d.path}>{d.path}</span>
              <button
                disabled={!controller.fileReady}
                onClick={() =>
                  void controller
                    .openDeletedDraft(d)
                    .catch((e) => controller.reportError((e as Error).message))
                }
              >
                打开草稿
              </button>
            </div>
          ))}
        </div>
      )}
      {controller.recoverableDrafts.length > 0 && (
        <div className="workbench-intents">
          <b>本地未保存草稿</b>
          {controller.recoverableDrafts.map((d) => (
            <div key={JSON.stringify(d)}>
              <span title={d.path}>{d.path}</span>
              <button
                disabled={!controller.fileReady}
                onClick={() =>
                  void controller
                    .openRecoverableDraft(d)
                    .catch((e) => controller.reportError((e as Error).message))
                }
              >
                打开草稿
              </button>
            </div>
          ))}
        </div>
      )}
      {controller.archivedDrafts.length > 0 && (
        <div className="workbench-intents archived-drafts">
          <b>旧目录的本地草稿</b>
          <small>草稿不会自动写入当前目录；待确认操作可导出完整记录。</small>
          {controller.archivedDrafts.map(
            ({ identity, page, stored, pagePending, storedPending }) => (
              <div key={JSON.stringify(identity)}>
                <span title={identity.path}>
                  修订 {identity.rootRevision} · {identity.path}
                </span>
                <div className="archived-actions">
                  {page && (
                    <button
                      onClick={() =>
                        void downloadArchived(
                          controller,
                          identity,
                          "page",
                          false,
                        ).catch((e) =>
                          controller.reportError((e as Error).message),
                        )
                      }
                    >
                      导出页面文本
                    </button>
                  )}
                  {page && pagePending && (
                    <button
                      onClick={() =>
                        void downloadArchived(
                          controller,
                          identity,
                          "page",
                          true,
                        ).catch((e) =>
                          controller.reportError((e as Error).message),
                        )
                      }
                    >
                      导出页面记录
                    </button>
                  )}
                  {stored && (
                    <button
                      onClick={() =>
                        void downloadArchived(
                          controller,
                          identity,
                          "stored",
                          false,
                        ).catch((e) =>
                          controller.reportError((e as Error).message),
                        )
                      }
                    >
                      导出已保存文本
                    </button>
                  )}
                  {stored && storedPending && (
                    <button
                      onClick={() =>
                        void downloadArchived(
                          controller,
                          identity,
                          "stored",
                          true,
                        ).catch((e) =>
                          controller.reportError((e as Error).message),
                        )
                      }
                    >
                      导出已保存记录
                    </button>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
      )}
      {controller.transfer && (
        <div className="workbench-hint" role="status">
          {controller.transfer}
          <button onClick={controller.cancelTransfer}>取消传输</button>
        </div>
      )}
      {controller.downloadMessage && (
        <div className="workbench-hint" role="status">
          {controller.downloadMessage}
          <button onClick={controller.clearDownloadMessage}>关闭</button>
        </div>
      )}
      {controller.intents.length > 0 && (
        <div className="workbench-intents">
          <b>待确认的文件操作</b>
          {controller.intents.map((intent) => (
            <div key={intent.opID}>
              <span title={intent.path}>{intent.path}</span>
              <button
                disabled={
                  !controller.supportsCreate ||
                  !controller.fileReady ||
                  !!controller.transfer ||
                  controller.renaming ||
                  (intent.kind === "rename" && !controller.supportsRename) ||
                  (intent.kind === "delete" && !controller.supportsDelete)
                }
                onClick={() =>
                  intent.kind === "upload"
                    ? chooseUpload(intent)
                    : intent.kind === "delete"
                      ? onDelete(intent.path, !!intent.recursive, intent)
                      : intent.kind === "rename"
                        ? void controller
                            .retryRename(intent)
                            .catch((e) =>
                              controller.reportError((e as Error).message),
                            )
                        : void controller
                            .retryCreate(intent)
                            .catch((e) =>
                              controller.reportError((e as Error).message),
                            )
                }
              >
                {intent.kind === "upload" ? "选择原文件继续" : "核对并继续"}
              </button>
              {intent.kind === "upload" && (
                <>
                  <button
                    disabled={!controller.fileReady || !!controller.transfer}
                    onClick={() =>
                      void controller
                        .checkUploadIntent(intent)
                        .then(controller.reportError)
                        .catch((e) =>
                          controller.reportError((e as Error).message),
                        )
                    }
                  >
                    核对状态
                  </button>
                  <button
                    disabled={!controller.fileReady || !!controller.transfer}
                    onClick={() =>
                      void controller
                        .checkUploadIntent(intent, true)
                        .then(controller.reportError)
                        .catch((e) =>
                          controller.reportError((e as Error).message),
                        )
                    }
                  >
                    取消上传
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="workbench-management">
        <button title="会话管理" aria-label="会话管理" onClick={onSessions}>
          <TerminalSquare size={17} />
        </button>
        <button title="节点管理" aria-label="节点管理" onClick={onNodes}>
          <Server size={17} />
        </button>
        <button title="账户管理" aria-label="账户管理" onClick={onAccount}>
          <UserRound size={17} />
        </button>
        <button title="设置" aria-label="设置" onClick={onSettings}>
          <Settings2 size={17} />
        </button>
      </div>
    </div>
  );
}

async function downloadArchived(
  controller: WorkspaceController,
  identity: DraftIdentity,
  source: "page" | "stored",
  record: boolean,
) {
  const draft = await controller.exportArchivedDraft(identity, source);
  let blob = new Blob([draft.text], { type: "text/plain;charset=utf-8" }),
    suffix = ".workdeck-draft.txt";
  if (record) {
    const pending = draft.pendingSave;
    if (
      !pending ||
      !(pending.content instanceof Uint8Array) ||
      pending.content.byteLength > 64 * 1024 * 1024
    )
      throw new Error(
        "待确认记录无效或超过 64 MiB，请保留浏览器草稿并先导出文本",
      );
    const { pendingSave: _ignored, ...rest } = draft;
    const prefix = JSON.stringify({
      ...rest,
      format: "workdeck-draft-v1",
    }).slice(0, -1);
    const pendingPrefix = JSON.stringify({
      ...pending,
      content: undefined,
      contentBase64: undefined,
    }).slice(0, -1);
    const parts: BlobPart[] = [
      prefix + ',"pendingSave":' + pendingPrefix + ',"contentBase64":"',
    ];
    // 49152 is divisible by three, so concatenating encoded chunks preserves
    // the original bytes without allocating one large binary string.
    for (let offset = 0; offset < pending.content.length; offset += 49152)
      parts.push(
        btoa(
          String.fromCharCode(
            ...pending.content.subarray(offset, offset + 49152),
          ),
        ),
      );
    parts.push('"}}');
    blob = new Blob(parts, { type: "application/json;charset=utf-8" });
    suffix = ".workdeck-draft.json";
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = (identity.path.split("/").pop() || "draft") + suffix;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportDraft(doc: Document) {
  const blob = new Blob([doc.text], { type: "text/plain;charset=utf-8" }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = (doc.path.split("/").pop() || "draft") + ".workdeck-draft.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function WorkspaceRootForm({
  controller,
  terminal,
  node,
  onCancel,
  onBusy,
  onDone,
}: {
  controller: WorkspaceController;
  terminal: TerminalRecord;
  node?: ComputeNode;
  onCancel: () => void;
  onBusy: (busy: boolean) => void;
  onDone: (state: "changed" | "pending") => void;
}) {
  const [original] = useState(() => ({
    workspace: controller.workspace?.id || "",
    revision: controller.workspace?.root_revision || 0,
    terminal: terminal.id,
    root: controller.workspace?.root_path || "",
  }));
  const [path, setPath] = useState(original.root),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        onBusy(true);
        setError("");
        try {
          onDone(
            await controller.changeRoot(
              path,
              original.workspace,
              original.revision,
              original.terminal,
            ),
          );
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
          onBusy(false);
        }
      }}
    >
      <div className="modal-symbol">
        <FolderCog size={24} />
      </div>
      <h2>更换工作区目录</h2>
      <p className="modal-description">
        选择新的文件树根目录。现有终端会继续运行，Shell
        当前目录不会改变。切换前请处理未保存草稿和待确认文件操作。
      </p>
      <fieldset className="directory-fieldset" disabled={busy}>
        <DirectoryPicker
          node={node}
          value={path}
          onChange={setPath}
          purpose="workspace"
          autoFocus
        />
      </fieldset>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </button>
        <button
          className="primary"
          disabled={busy || !path || path === original.root}
        >
          {busy ? "正在切换…" : "确认切换目录"}
        </button>
      </div>
    </form>
  );
}
export function WorkspaceEditor({
  controller,
  onCloseDocument,
  onSaveDeletedAs,
  onDiscardDeleted,
}: {
  controller: WorkspaceController;
  onCloseDocument: (doc: Document) => void;
  onSaveDeletedAs: (doc: Document) => void;
  onDiscardDeleted: (doc: Document) => void;
}) {
  const doc = controller.document;
  const preview = controller.preview;
  const markdown = !!doc && /\.(?:md|markdown|mdown)$/i.test(doc.path);
  const [markdownMode, setMarkdownMode] = useState<
    "edit" | "preview" | "split"
  >("edit");
  const [comparison, setComparison] = useState<ConflictSnapshot | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState("");
  const compareSequence = useRef(0);
  useEffect(() => {
    compareSequence.current++;
    setComparison(null);
    setComparing(false);
    setCompareError("");
    return () => {
      compareSequence.current++;
    };
  }, [doc?.identity.workspaceID, doc?.identity.rootRevision, doc?.path]);
  const compareRemote = async () => {
    if (!doc || comparing) return;
    const sequence = ++compareSequence.current;
    setComparing(true);
    setCompareError("");
    try {
      const snapshot = await controller.readConflict(doc);
      if (sequence === compareSequence.current) setComparison(snapshot);
    } catch (e) {
      if (sequence === compareSequence.current)
        setCompareError((e as Error).message);
    } finally {
      if (sequence === compareSequence.current) setComparing(false);
    }
  };
  useEffect(
    () => setMarkdownMode("edit"),
    [doc?.identity.workspaceID, doc?.path],
  );
  return (
    <section className="workbench-editor" aria-label="文件工作区">
      <div className="workbench-tabs">
        {controller.documents.map(([id, item]) => (
          <div
            key={id}
            className={
              "workbench-tab " + (id === controller.selected ? "active" : "")
            }
          >
            <button
              className="workbench-tab-select"
              onClick={() => controller.select(id)}
              title={item.path}
            >
              <File size={14} />
              <span>{item.path.split("/").pop()}</span>
              {item.text !== item.base && <i aria-label="未保存">●</i>}
            </button>
            <button
              className="workbench-tab-close"
              aria-label={`关闭文件 ${item.path}`}
              title="关闭文件"
              onClick={() => onCloseDocument(item)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {controller.previews.map(([id, item]) => (
          <div
            key={id}
            className={
              "workbench-tab " + (id === controller.selected ? "active" : "")
            }
          >
            <button
              className="workbench-tab-select"
              onClick={() => controller.select(id)}
              title={item.path}
            >
              <File size={14} />
              <span>{item.path.split("/").pop()}</span>
            </button>
            <button
              className="workbench-tab-close"
              aria-label={`关闭文件 ${item.path}`}
              title="关闭文件"
              onClick={() => controller.closePreview(id)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="workbench-editor-toolbar">
        <span>
          {doc?.path ||
            preview?.path ||
            controller.workspace?.root_path ||
            "文件工作区"}
        </span>
        <span
          className="workbench-route"
          title={
            controller.fileMetrics
              ? `中转 ${formatLatency(controller.fileMetrics.relayLatency)}，直连 ${formatLatency(controller.fileMetrics.directLatency)}；文件数据上行 ${formatBytes(controller.fileMetrics.traffic[controller.fileMetrics.route].sendRate)}/s，下行 ${formatBytes(controller.fileMetrics.traffic[controller.fileMetrics.route].receiveRate)}/s${controller.fileMetrics.adaptiveDelayMs ? `；终端延迟持续升高，文件块间隔 ${controller.fileMetrics.adaptiveDelayMs} ms` : ""}`
              : "文件链路状态"
          }
        >
          文件 · {controller.connection}
          {controller.fileMetrics && (
            <>
              {" "}
              · 中转 {formatLatency(controller.fileMetrics.relayLatency)} / 直连{" "}
              {formatLatency(controller.fileMetrics.directLatency)} · ↑
              {formatBytes(
                controller.fileMetrics.traffic[controller.fileMetrics.route]
                  .sendRate,
              )}
              /s ↓
              {formatBytes(
                controller.fileMetrics.traffic[controller.fileMetrics.route]
                  .receiveRate,
              )}
              /s
              {controller.fileMetrics.adaptiveDelayMs > 0 && <> · 终端优先</>}
            </>
          )}
        </span>
        {markdown && (
          <div className="markdown-modes" aria-label="Markdown 视图">
            <button
              className={markdownMode === "edit" ? "active" : ""}
              onClick={() => setMarkdownMode("edit")}
            >
              编辑
            </button>
            <button
              className={markdownMode === "preview" ? "active" : ""}
              onClick={() => setMarkdownMode("preview")}
            >
              预览
            </button>
            <button
              className={markdownMode === "split" ? "active" : ""}
              onClick={() => setMarkdownMode("split")}
            >
              并排
            </button>
          </div>
        )}
        {doc && (
          <button
            className="secondary"
            disabled={
              doc.saving ||
              controller.renaming ||
              !!doc.warning ||
              doc.conflict ||
              !controller.fileReady
            }
            onClick={() => void controller.save(doc)}
          >
            <Save size={14} />
            {doc.saving ? "保存中…" : doc.pending ? "确认并继续保存" : "保存"}
          </button>
        )}
      </div>
      {controller.error && (
        <div className="workbench-notice">
          {controller.error}{" "}
          <button onClick={controller.retry}>重新连接</button>
        </div>
      )}
      {controller.unrestoredTabs.length > 0 && (
        <div className="workbench-notice" role="status">
          以下文件标签暂时无法恢复：{controller.unrestoredTabs.join("、")}
          。本地草稿仍会保留。
          <button onClick={controller.retry}>重试恢复</button>
          <button onClick={controller.forgetUnrestoredTabs}>
            移除未恢复的标签
          </button>
        </div>
      )}
      {doc?.pending && (
        <div className="workbench-notice">
          保存结果待确认，本地草稿已保留。
          <button
            disabled={
              doc.saving || controller.renaming || !controller.fileReady
            }
            onClick={() => void controller.checkPendingSave(doc)}
          >
            核对保存状态
          </button>
          {(doc.pendingState === "receiving" ||
            doc.pendingState === "ready") && (
            <button
              disabled={
                doc.saving || controller.renaming || !controller.fileReady
              }
              onClick={() => void controller.checkPendingSave(doc, true)}
            >
              取消未完成保存
            </button>
          )}
        </div>
      )}
      {doc?.conflict && (
        <div className="workbench-notice">
          {doc.deleted
            ? "远端文件已删除，本地草稿已保留。"
            : doc.unavailable
              ? "远端文件不存在或无法访问，本地草稿已保留。"
              : "远端文件已改变，本地草稿已保留。请导出草稿并比较后处理。"}
          {(doc.deleted || doc.unavailable) && (
            <button
              disabled={
                doc.saving ||
                controller.renaming ||
                !controller.fileReady ||
                (!!doc.pending && !doc.pending.spec.create)
              }
              onClick={() => onSaveDeletedAs(doc)}
            >
              {doc.pending ? "核对并继续另存" : "另存为新文件"}
            </button>
          )}
          {!doc.deleted && !doc.unavailable && (
            <button
              disabled={
                doc.saving ||
                !!doc.pending ||
                controller.renaming ||
                !controller.fileReady ||
                comparing
              }
              onClick={() => void compareRemote()}
            >
              {comparing ? "正在读取远端版本…" : "比较远端版本"}
            </button>
          )}
          {(doc.deleted || doc.unavailable) && (
            <button
              disabled={doc.saving || !!doc.pending || controller.renaming}
              onClick={() => onDiscardDeleted(doc)}
            >
              移除本地草稿
            </button>
          )}
          <button onClick={() => exportDraft(doc)}>
            <Download size={14} />
            导出草稿
          </button>
        </div>
      )}
      {doc?.warning && (
        <div className="workbench-notice">
          {doc.warning}{" "}
          <button onClick={() => exportDraft(doc)}>
            <Download size={14} />
            导出内容
          </button>
        </div>
      )}
      {doc?.message && <div className="workbench-notice">{doc.message}</div>}
      {doc?.persistenceError && (
        <div className="workbench-notice">
          草稿未能保存到浏览器：{doc.persistenceError}{" "}
          <button onClick={() => exportDraft(doc)}>
            <Download size={14} />
            导出草稿
          </button>
        </div>
      )}
      {compareError && (
        <div className="workbench-notice" role="alert">
          {compareError}
        </div>
      )}
      {doc && comparison && doc.conflict && (
        <div className="workbench-compare-toolbar">
          <span>左侧：远端版本　右侧：本地草稿</span>
          <button
            disabled={
              doc.saving ||
              !!doc.pending ||
              !!doc.warning ||
              controller.renaming ||
              !controller.fileReady ||
              comparing
            }
            onClick={() => {
              void controller
                .acceptConflictBase(doc, comparison)
                .then(() => setComparison(null))
                .catch((e) => setCompareError((e as Error).message));
            }}
          >
            采用此远端版本作为保存基准
          </button>
          <button
            onClick={() => {
              compareSequence.current++;
              setComparison(null);
              setCompareError("");
            }}
          >
            关闭比较
          </button>
        </div>
      )}
      {doc ? (
        <div className="workbench-document">
          <div
            className={
              "workbench-code " +
              (comparison || (markdown && markdownMode === "preview")
                ? "hidden"
                : "")
            }
          >
            <Suspense
              fallback={<div className="workbench-empty">正在加载编辑器…</div>}
            >
              <MonacoEditor
                document={doc}
                readOnly={controller.renaming || !!doc.closing}
                onChange={(text) => controller.edit(doc, text)}
                onSave={() => void controller.save(doc)}
              />
            </Suspense>
          </div>
          {comparison && doc.conflict && (
            <div className="workbench-code">
              <Suspense
                fallback={
                  <div className="workbench-empty">正在加载差异视图…</div>
                }
              >
                <ConflictDiff remote={comparison.text} local={doc.text} />
              </Suspense>
            </div>
          )}
          {!comparison &&
            markdown &&
            markdownMode !== "edit" &&
            (controller.client ? (
              <Suspense
                fallback={
                  <div className="workbench-empty">正在加载 Markdown 预览…</div>
                }
              >
                <MarkdownPreview
                  text={doc.text}
                  path={doc.path}
                  client={controller.client}
                  onOpen={(path) => void controller.openFile(path)}
                />
              </Suspense>
            ) : (
              <div className="workbench-empty">文件连接已断开</div>
            ))}
        </div>
      ) : preview && controller.client ? (
        <Suspense
          fallback={<div className="workbench-empty">正在加载预览…</div>}
        >
          {preview.kind === "image" ? (
            <ImagePreview client={controller.client} preview={preview} />
          ) : (
            <PDFPreview
              key={JSON.stringify(preview.identity)}
              client={controller.client}
              preview={preview}
            />
          )}
        </Suspense>
      ) : preview ? (
        <div className="workbench-empty">文件连接已断开</div>
      ) : (
        <div className="workbench-empty">
          从左侧选择文件，或在下方继续使用终端。
        </div>
      )}
    </section>
  );
}

export function CloseDocumentForm({
  controller,
  doc,
  onClose,
}: {
  controller: WorkspaceController;
  doc: Document;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (action: "save" | "discard" | "keep") => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await controller.closeDocument(doc, action);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const blocked = busy || doc.saving || !!doc.closing;
  return (
    <div>
      <div className="modal-symbol">
        <File size={24} />
      </div>
      <h2>关闭文件</h2>
      <p className="modal-description">
        {doc.path}{" "}
        有未处理的内容。可以保存、放弃修改，或将草稿保留在此浏览器中。
      </p>
      {doc.pending && (
        <div className="form-hint">
          保存结果待确认，不能放弃该操作；可保留草稿并稍后核对。
        </div>
      )}
      {doc.conflict && (
        <div className="form-hint">
          文件存在冲突或不可访问；请先比较或另存，才能保存到原路径。
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions close-document-actions">
        <button
          type="button"
          className="secondary"
          disabled={blocked}
          onClick={onClose}
        >
          取消
        </button>
        <button
          type="button"
          className="secondary"
          disabled={blocked || !!doc.pending}
          onClick={() => void act("discard")}
        >
          放弃修改
        </button>
        <button
          type="button"
          className="secondary"
          disabled={blocked}
          onClick={() => void act("keep")}
        >
          保留草稿并关闭
        </button>
        <button
          type="button"
          className="primary"
          disabled={
            blocked ||
            !!doc.pending ||
            doc.conflict ||
            !!doc.deleted ||
            !!doc.unavailable ||
            !!doc.warning ||
            !!doc.persistenceError ||
            !controller.fileReady
          }
          onClick={() => void act("save")}
        >
          保存并关闭
        </button>
      </div>
    </div>
  );
}

export function DiscardDeletedDraftForm({
  controller,
  doc,
  onClose,
}: {
  controller: WorkspaceController;
  doc: Document;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          await controller.discardDeletedDraft(doc);
          onClose();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="modal-symbol">
        <Trash2 size={24} />
      </div>
      <h2>移除本地草稿</h2>
      <p className="modal-description">
        将移除此浏览器中 {doc.path} 的草稿，未另存或导出的修改会丢失。
      </p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          onClick={onClose}
          disabled={busy}
        >
          取消
        </button>
        <button className="primary" disabled={busy}>
          {busy ? "正在移除…" : "确认移除草稿"}
        </button>
      </div>
    </form>
  );
}

export function SaveDeletedAsForm({
  controller,
  doc,
  onClose,
}: {
  controller: WorkspaceController;
  doc: Document;
  onClose: () => void;
}) {
  const [name, setName] = useState(() => doc.path.split("/").pop() + ".copy");
  const [target] = useState(() => ({
    parent: controller.selectedDirectory,
    id: controller.workspace?.id || "",
    revision: controller.workspace?.root_revision || 0,
  }));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          await controller.saveDeletedAs(
            doc,
            name,
            target.parent,
            target.id,
            target.revision,
          );
          onClose();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="modal-symbol">
        <Save size={24} />
      </div>
      <h2>{doc.unavailable ? "另存不可访问的草稿" : "另存已删除的草稿"}</h2>
      <p className="modal-description">
        {doc.pending
          ? `继续核对并保存到 ${doc.pending.spec.path}`
          : `将在 ${target.parent === "." ? "工作区根目录" : target.parent} 创建新文件，不覆盖已有文件。`}
      </p>
      {!doc.pending && (
        <label>
          新文件名
          <input
            aria-label="另存文件名"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            maxLength={255}
          />
        </label>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onClose}
        >
          取消
        </button>
        <button className="primary" disabled={busy || (!doc.pending && !name)}>
          {busy ? "正在保存…" : doc.pending ? "核对并继续" : "另存"}
        </button>
      </div>
    </form>
  );
}

export function DeleteItemForm({
  controller,
  path,
  directory,
  existing,
  onClose,
}: {
  controller: WorkspaceController;
  path: string;
  directory: boolean;
  existing?: CreateIntent;
  onClose: () => void;
}) {
  const [target] = useState(() => ({
    id: controller.workspace?.id || "",
    revision: controller.workspace?.root_revision || 0,
  }));
  const [intent, setIntent] = useState<CreateIntent | undefined>(existing),
    [status, setStatus] = useState<DeleteStatus | undefined>();
  const [outcomes, setOutcomes] = useState<DeleteOutcome[]>([]),
    [next, setNext] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const showPage = async (i: CreateIntent, offset: number) => {
    const page = await controller.deleteOutcomes(i, offset);
    setOutcomes((old) => (offset === 0 ? page.items : [...old, ...page.items]));
    setNext(page.next);
  };
  const inspect = async () => {
    setBusy(true);
    setError("");
    try {
      if (intent) {
        let s = await controller.inspectDelete(intent);
        if (
          ["committed", "partial", "uncertain", "aborted"].includes(s.state)
        ) {
          const result = await controller.executeDelete(intent, false);
          setIntent(result.intent);
          s = result.status;
          await showPage(result.intent, 0);
        }
        setStatus(s);
      } else {
        const r = await controller.beginDelete(
          path,
          directory,
          target.id,
          target.revision,
        );
        setIntent(r.intent);
        setStatus(r.preview);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const execute = async (authorize: boolean) => {
    if (!intent) return;
    setBusy(true);
    setError("");
    try {
      const result = await controller.executeDelete(intent, authorize);
      setIntent(result.intent);
      setStatus(result.status);
      if (
        ["committed", "partial", "uncertain", "aborted"].includes(
          result.status.state,
        )
      )
        await showPage(result.intent, 0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!intent) {
      onClose();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await controller.cancelDelete(intent);
      if (result.state === "aborted") onClose();
      else {
        setStatus(result);
        await showPage(intent, 0);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="modal-symbol">
        <Trash2 size={24} />
      </div>
      <h2>删除文件或文件夹</h2>
      <p className="modal-description">
        工作区：{controller.workspace?.root_path || "—"}
        <br />
        路径：{path}
        <br />
        {directory
          ? "将递归处理此目录中确认清单内的所有项目。"
          : "将删除此文件。"}
      </p>
      {!status && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void inspect()}
        >
          {busy ? "正在核对…" : intent ? "核对删除状态" : "检查删除范围"}
        </button>
      )}
      {status && (
        <div className="modal-description">
          <p>
            清单：{status.count} 项，其中 {status.directories}{" "}
            个目录；文件总大小 {status.bytes} 字节。
          </p>
          {status.deleted !== undefined && (
            <p>
              已删除 {status.deleted} 项，跳过 {status.skipped} 项，未处理{" "}
              {status.pending} 项，待核对 {status.uncertain} 项。
            </p>
          )}
          {status.state === "prepared" && !intent?.confirmed && (
            <p>确认后开始删除；稍后出现的文件不在本次清单中。</p>
          )}
          {status.state === "uncertain" && (
            <p>结果尚不明确，请检查下方项目和暂存路径；操作记录会保留。</p>
          )}
          {status.state === "partial" && (
            <p>部分项目未删除，请检查下方详情。</p>
          )}
        </div>
      )}
      {outcomes.length > 0 && (
        <div className="delete-outcomes" aria-label="删除结果">
          {outcomes.map((item, index) => (
            <div key={`${index}:${item.path}`}>
              <span>
                {item.path} ·{" "}
                {item.state === "deleted"
                  ? "已删除"
                  : item.state === "skipped"
                    ? "跳过"
                    : item.state === "uncertain"
                      ? "待核对"
                      : "未完成"}
              </span>
              {item.error && <small>{item.error.message}</small>}
            </div>
          ))}
          {status && next < status.count && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void showPage(intent!, next).catch((e) =>
                  setError((e as Error).message),
                )
              }
            >
              加载更多结果
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}。若结果尚未确认，可在文件树下方核对。
        </div>
      )}
      <div className="form-actions">
        {status && ["committed", "aborted"].includes(status.state) ? (
          <button className="primary" onClick={onClose}>
            完成
          </button>
        ) : (
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                status && ["partial", "uncertain"].includes(status.state)
                  ? onClose()
                  : void cancel()
              }
            >
              {status?.state === "deleting"
                ? "停止剩余项"
                : status && ["partial", "uncertain"].includes(status.state)
                  ? "关闭"
                  : "取消"}
            </button>
            {status?.state === "partial" && (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void controller
                    .acknowledgeDelete(intent!)
                    .then(onClose)
                    .catch((e) => setError((e as Error).message))
                }
              >
                已查看结果
              </button>
            )}
            {status && ["prepared", "deleting"].includes(status.state) && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void execute(!intent?.confirmed)}
              >
                {busy
                  ? "正在删除…"
                  : intent?.confirmed
                    ? "继续删除"
                    : "确认删除"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function RenameItemForm({
  controller,
  source,
  onCancel,
  onRenamed,
}: {
  controller: WorkspaceController;
  source: string;
  onCancel: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState(() => source.split("/").pop() || "");
  const [target] = useState(() => ({
    id: controller.workspace?.id || "",
    revision: controller.workspace?.root_revision || 0,
  }));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          await controller.renameItem(source, name, target.id, target.revision);
          onRenamed();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="modal-symbol">
        <Pencil size={24} />
      </div>
      <h2>重命名文件或文件夹</h2>
      <p className="modal-description">当前路径：{source}</p>
      <label>
        新名称
        <input
          aria-label="新的文件名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          maxLength={255}
        />
      </label>
      {error && (
        <div className="form-error" role="alert">
          {error}。若结果尚未确认，可在文件树下方核对。
        </div>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          onClick={onCancel}
          disabled={busy}
        >
          取消
        </button>
        <button className="primary" disabled={busy || !name}>
          {busy ? "正在重命名…" : "重命名"}
        </button>
      </div>
    </form>
  );
}

export function CreateItemForm({
  controller,
  onCancel,
  onCreated,
}: {
  controller: WorkspaceController;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState(""),
    [kind, setKind] = useState<"file" | "directory">("file"),
    [target] = useState(() => ({
      parent: controller.selectedDirectory,
      id: controller.workspace?.id || "",
      revision: controller.workspace?.root_revision || 0,
    })),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          await controller.createItem(
            name,
            kind,
            target.parent,
            target.id,
            target.revision,
          );
          onCreated();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="modal-symbol">
        <Plus size={24} />
      </div>
      <h2>新建文件或文件夹</h2>
      <p className="modal-description">
        将在工作区目录 {target.parent === "." ? "根目录" : target.parent}{" "}
        中创建。
      </p>
      <label>
        类型
        <select
          aria-label="创建类型"
          value={kind}
          onChange={(e) => setKind(e.target.value as "file" | "directory")}
        >
          <option value="file">文件</option>
          <option value="directory">文件夹</option>
        </select>
      </label>
      <label>
        名称
        <input
          aria-label="文件名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          maxLength={255}
        />
      </label>
      {error && (
        <div className="form-error" role="alert">
          {error}。若结果尚未确认，可关闭后在文件树下方核对并继续。
        </div>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          onClick={onCancel}
          disabled={busy}
        >
          取消
        </button>
        <button className="primary" disabled={busy || !name}>
          {busy ? "正在创建…" : "创建"}
        </button>
      </div>
    </form>
  );
}
