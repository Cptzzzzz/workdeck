import { lazy, Suspense, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  RefreshCw,
  Save,
  Download,
  Plus,
  Server,
  Settings2,
  LogOut,
  TerminalSquare,
} from "lucide-react";
import type { WorkspaceController, Document } from "./use-workspace";
const MonacoEditor = lazy(() =>
  import("./monaco-editor").then((m) => ({ default: m.MonacoEditor })),
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
  onJoin,
  onCreate,
  onPassword,
  onLogout,
  onNewItem,
}: {
  controller: WorkspaceController;
  onJoin: () => void;
  onCreate: () => void;
  onPassword: () => void;
  onLogout: () => void;
  onNewItem: () => void;
}) {
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
            title={
              controller.supportsCreate
                ? "新建文件或文件夹"
                : "请先升级节点以启用文件创建"
            }
            aria-label="新建文件或文件夹"
            disabled={
              !controller.supportsCreate ||
              !controller.workspace ||
              controller.connection !== "中转连接"
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
      {controller.intents.length > 0 && (
        <div className="workbench-intents">
          <b>待确认的创建操作</b>
          {controller.intents.map((intent) => (
            <div key={intent.opID}>
              <span title={intent.path}>{intent.path}</span>
              <button
                disabled={
                  !controller.supportsCreate ||
                  controller.connection !== "中转连接"
                }
                onClick={() =>
                  void controller
                    .retryCreate(intent)
                    .catch((e) => controller.reportError((e as Error).message))
                }
              >
                核对并继续
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="workbench-management">
        <button title="新建终端" aria-label="新建终端" onClick={onCreate}>
          <TerminalSquare size={17} />
        </button>
        <button title="接入节点" aria-label="接入节点" onClick={onJoin}>
          <Server size={17} />
          <Plus size={11} />
        </button>
        <button title="修改密码" aria-label="修改密码" onClick={onPassword}>
          <Settings2 size={17} />
        </button>
        <button title="退出此设备" aria-label="退出此设备" onClick={onLogout}>
          <LogOut size={17} />
        </button>
      </div>
    </div>
  );
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
export function WorkspaceEditor({
  controller,
}: {
  controller: WorkspaceController;
}) {
  const doc = controller.document;
  const preview = controller.preview;
  const markdown = !!doc && /\.(?:md|markdown|mdown)$/i.test(doc.path);
  const [markdownMode, setMarkdownMode] = useState<
    "edit" | "preview" | "split"
  >("edit");
  useEffect(
    () => setMarkdownMode("edit"),
    [doc?.identity.workspaceID, doc?.path],
  );
  return (
    <section className="workbench-editor" aria-label="文件工作区">
      <div className="workbench-tabs">
        {controller.documents.map(([id, item]) => (
          <button
            key={id}
            className={id === controller.selected ? "active" : ""}
            onClick={() => controller.select(id)}
            title={item.path}
          >
            <File size={14} />
            <span>{item.path.split("/").pop()}</span>
            {item.text !== item.base && <i aria-label="未保存">●</i>}
          </button>
        ))}
        {controller.previews.map(([id, item]) => (
          <button
            key={id}
            className={id === controller.selected ? "active" : ""}
            onClick={() => controller.select(id)}
            title={item.path}
          >
            <File size={14} />
            <span>{item.path.split("/").pop()}</span>
          </button>
        ))}
      </div>
      <div className="workbench-editor-toolbar">
        <span>
          {doc?.path ||
            preview?.path ||
            controller.workspace?.root_path ||
            "文件工作区"}
        </span>
        <span className="workbench-route">文件 · {controller.connection}</span>
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
              !!doc.warning ||
              doc.conflict ||
              controller.connection !== "中转连接"
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
      {doc?.conflict && (
        <div className="workbench-notice">
          远端文件已改变，本地草稿已保留。请导出草稿并比较后处理。
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
      {doc ? (
        <div className="workbench-document">
          <div
            className={
              "workbench-code " +
              (markdown && markdownMode === "preview" ? "hidden" : "")
            }
          >
            <Suspense
              fallback={<div className="workbench-empty">正在加载编辑器…</div>}
            >
              <MonacoEditor
                document={doc}
                onChange={(text) => controller.edit(doc, text)}
                onSave={() => void controller.save(doc)}
              />
            </Suspense>
          </div>
          {markdown &&
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
            <PDFPreview client={controller.client} preview={preview} />
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
