import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import type { Document } from "./use-workspace";

(
  globalThis as typeof globalThis & { MonacoEnvironment?: unknown }
).MonacoEnvironment = { getWorker: () => new EditorWorker() };

export function MonacoEditor({
  document,
  onChange,
  onSave,
  readOnly = false,
}: {
  document: Document;
  onChange: (value: string) => void;
  onSave: () => void;
  readOnly?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null),
    editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null),
    model = useRef<monaco.editor.ITextModel | null>(null);
  const applyingRemote = useRef(false);
  const changeRef = useRef(onChange),
    saveRef = useRef(onSave);
  changeRef.current = onChange;
  saveRef.current = onSave;
  useEffect(() => {
    if (!root.current) return;
    const instance = monaco.editor.create(root.current, {
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "off",
      renderWhitespace: "selection",
      ariaLabel: "文件编辑器",
    });
    editor.current = instance;
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current(),
    );
    return () => {
      instance.dispose();
      model.current?.dispose();
      model.current = null;
      editor.current = null;
    };
  }, []);
  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    const ext = document.path.split(".").pop()?.toLowerCase();
    const languages: Record<string, string> = {
      js: "javascript",
      jsx: "javascript",
      ts: "typescript",
      tsx: "typescript",
      json: "json",
      md: "markdown",
      go: "go",
      py: "python",
      sh: "shell",
      bash: "shell",
      html: "html",
      css: "css",
      yaml: "yaml",
      yml: "yaml",
      rs: "rust",
      c: "c",
      cpp: "cpp",
      java: "java",
      sql: "sql",
    };
    const current = monaco.editor.createModel(
      document.text,
      languages[ext || ""] || "plaintext",
    );
    current.setEOL(
      document.newline === "crlf"
        ? monaco.editor.EndOfLineSequence.CRLF
        : monaco.editor.EndOfLineSequence.LF,
    );
    const previous = model.current;
    model.current = current;
    instance.setModel(current);
    previous?.dispose();
    const listener = current.onDidChangeContent(() => {
      if (!applyingRemote.current) changeRef.current(current.getValue());
    });
    return () => listener.dispose();
  }, [
    document.identity.workspaceID,
    document.identity.rootRevision,
    document.path,
  ]);
  useEffect(() => {
    const instance = editor.current,
      current = model.current;
    if (!instance || !current) return;
    instance.updateOptions({ readOnly: !!document.warning || readOnly });
    if (current.getValue() !== document.text) {
      const view = instance.saveViewState();
      applyingRemote.current = true;
      try {
        current.setValue(document.text);
        current.setEOL(
          document.newline === "crlf"
            ? monaco.editor.EndOfLineSequence.CRLF
            : monaco.editor.EndOfLineSequence.LF,
        );
      } finally {
        applyingRemote.current = false;
      }
      if (view) instance.restoreViewState(view);
    }
  }, [document.text, document.warning, document.newline, readOnly]);
  return <div className="workbench-monaco" ref={root} />;
}
