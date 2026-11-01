import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "./monaco-setup";
import type { Document } from "./use-workspace";
import {
  readEditorView,
  writeEditorView,
  type EditorViewState,
} from "../../services/files/view-state";

let modelSequence = 0;

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
  const [viewError, setViewError] = useState("");
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
    const fileName = document.path.split("/").pop() || "file";
    const uri = monaco.Uri.from({
      scheme: "inmemory",
      path: `/${++modelSequence}/${fileName}`,
    });
    const current = monaco.editor.createModel(document.text, undefined, uri);
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
    const identity = { ...document.identity };
    let active = true,
      ready = false,
      touched = false,
      timer = 0;
    let latest: EditorViewState | undefined;
    setViewError("");
    const capture = () => {
      const position = instance.getPosition();
      if (!position || instance.getModel() !== current) return;
      latest = {
        line: position.lineNumber,
        column: position.column,
        scrollTop: instance.getScrollTop(),
        scrollLeft: instance.getScrollLeft(),
      };
    };
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = 0;
      if (!latest || (!ready && !touched)) return;
      void writeEditorView(identity, latest)
        .then(() => {
          if (active) setViewError("");
        })
        .catch((e) => {
          if (active) setViewError((e as Error).message);
        });
    };
    const changed = () => {
      touched = true;
      capture();
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(flush, 200);
    };
    const cursorListener = instance.onDidChangeCursorPosition(changed);
    const scrollListener = instance.onDidScrollChange(changed);
    window.addEventListener("pagehide", flush);
    void readEditorView(identity)
      .then((saved) => {
        if (!active || instance.getModel() !== current) return;
        if (saved && !touched) {
          instance.setPosition({
            lineNumber: saved.line,
            column: saved.column,
          });
          instance.setScrollPosition({
            scrollTop: saved.scrollTop,
            scrollLeft: saved.scrollLeft,
          });
        }
        ready = true;
        capture();
        if (touched) flush();
      })
      .catch((e) => {
        if (!active) return;
        ready = true;
        setViewError((e as Error).message);
        if (touched) flush();
      });
    return () => {
      flush();
      active = false;
      window.removeEventListener("pagehide", flush);
      cursorListener.dispose();
      scrollListener.dispose();
      listener.dispose();
    };
  }, [
    document.identity.account,
    document.identity.nodeID,
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
  return (
    <div className="workbench-monaco-container">
      {viewError && (
        <div className="workbench-notice" role="status">
          编辑器视图保存失败：{viewError}
        </div>
      )}
      <div className="workbench-monaco" ref={root} />
    </div>
  );
}
