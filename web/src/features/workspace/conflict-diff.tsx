import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

(
  globalThis as typeof globalThis & { MonacoEnvironment?: unknown }
).MonacoEnvironment = { getWorker: () => new EditorWorker() };

export function ConflictDiff({
  remote,
  local,
}: {
  remote: string;
  local: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const original = useRef<monaco.editor.ITextModel | null>(null);
  const modified = useRef<monaco.editor.ITextModel | null>(null);
  useEffect(() => {
    if (!root.current) return;
    const editor = monaco.editor.createDiffEditor(root.current, {
      theme: "vs-dark",
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      minimap: { enabled: false },
      fontSize: 13,
    });
    const a = monaco.editor.createModel(remote, "plaintext"),
      b = monaco.editor.createModel(local, "plaintext");
    original.current = a;
    modified.current = b;
    editor.setModel({ original: a, modified: b });
    return () => {
      editor.dispose();
      a.dispose();
      b.dispose();
      original.current = null;
      modified.current = null;
    };
  }, []);
  useEffect(() => {
    if (original.current && original.current.getValue() !== remote)
      original.current.setValue(remote);
  }, [remote]);
  useEffect(() => {
    if (modified.current && modified.current.getValue() !== local)
      modified.current.setValue(local);
  }, [local]);
  return (
    <div
      className="workbench-monaco"
      ref={root}
      aria-label="远端版本与本地草稿差异"
    />
  );
}
