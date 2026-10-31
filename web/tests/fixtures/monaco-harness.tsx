import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MonacoEditor } from "../../src/features/workspace/monaco-editor";
import type { Document } from "../../src/features/workspace/use-workspace";
import "../../src/style.css";

function App() {
  const [path, setPath] = useState("hello.py");
  const [text, setText] = useState("def hello():\n    return 42\n");
  const document = {
    path,
    text,
    newline: "lf",
    identity: {
      account: "fixture",
      nodeID: "node",
      workspaceID: "workspace",
      rootRevision: 1,
    },
  } as Document;
  return (
    <>
      <button
        onClick={() => {
          setPath("Dockerfile");
          setText("FROM alpine:latest\nRUN echo hello\n");
        }}
      >
        Dockerfile
      </button>
      <button
        onClick={() => {
          setPath("config.json");
          setText('{"enabled": true}\n');
        }}
      >
        JSON
      </button>
      <div style={{ height: 500, display: "flex" }}>
        <MonacoEditor
          document={document}
          onChange={setText}
          onSave={() => {}}
        />
      </div>
      <output data-testid="text">{text}</output>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
