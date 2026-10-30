import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type { FileClient } from "../../services/files/client";
import { relativeWorkspacePath, safeImageBlob } from "./preview-utils";

type Budget = { active: number; bytes: number };
function MarkdownImage({
  source,
  path,
  client,
  alt,
  budget,
}: {
  source: string;
  path: string;
  client: FileClient;
  alt: string;
  budget: Budget;
}) {
  const [url, setURL] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    const target = relativeWorkspacePath(path, source);
    let canceled = false,
      objectURL = "",
      reserved = 0,
      active = false;
    setURL("");
    setError("");
    if (!target) {
      setError("图片地址不可用");
      return;
    }
    if (budget.active >= 16) {
      setError("图片预览数量已达上限");
      return;
    }
    budget.active++;
    active = true;
    void (async () => {
      try {
        const result = await client.readBytes(target, "", 5 * 1024 * 1024);
        if (canceled) return;
        if (budget.bytes + result.bytes.length > 32 * 1024 * 1024)
          throw new Error("图片预览总大小已达上限");
        budget.bytes += result.bytes.length;
        reserved = result.bytes.length;
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
      if (active) budget.active--;
      budget.bytes -= reserved;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [source, path, client, budget]);
  return url ? (
    <img src={url} alt={alt} />
  ) : (
    <span className="markdown-image-message">{error || "正在读取图片…"}</span>
  );
}
export function MarkdownPreview({
  text,
  path,
  client,
  onOpen,
}: {
  text: string;
  path: string;
  client: FileClient;
  onOpen: (path: string) => void;
}) {
  const budget = useMemo<Budget>(
    () => ({ active: 0, bytes: 0 }),
    [client, path],
  );
  return (
    <div className="markdown-preview" aria-label="Markdown 预览">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        urlTransform={(value, key) => {
          if (key === "src")
            return relativeWorkspacePath(path, value) ? value : "";
          if (
            key === "href" &&
            (/^https?:\/\//i.test(value) ||
              value.startsWith("#") ||
              relativeWorkspacePath(path, value))
          )
            return value;
          return "";
        }}
        components={{
          img: ({ src, alt }) =>
            src ? (
              <MarkdownImage
                source={src}
                path={path}
                client={client}
                alt={alt || ""}
                budget={budget}
              />
            ) : (
              <span className="markdown-image-message">图片地址已屏蔽</span>
            ),
          a: ({ href, children }) => {
            if (!href) return <span>{children}</span>;
            if (/^https?:\/\//i.test(href))
              return (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            if (href.startsWith("#")) return <a href={href}>{children}</a>;
            const target = relativeWorkspacePath(path, href);
            return target ? (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onOpen(target);
                }}
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
