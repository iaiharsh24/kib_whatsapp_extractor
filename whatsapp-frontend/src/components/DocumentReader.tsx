"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fileSrc, formatWhen, getToken } from "@/lib/api";
import type { MessageRecord } from "@/lib/types";

export type ReaderKind =
  | "pdf"
  | "markdown"
  | "text"
  | "html"
  | "docx"
  | "image"
  | "audio"
  | "video"
  | "unsupported";

const TEXT_EXT = new Set([
  "txt",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "yml",
  "log",
  "ini",
  "cfg",
  "conf",
  "rtf",
  "vcf",
  "md",
  "markdown",
  "mdx",
]);

export function extensionOf(name?: string | null): string {
  if (!name) return "";
  const base = name.split("?")[0].split("#")[0];
  const leaf = base.split("/").pop() || base;
  const dot = leaf.lastIndexOf(".");
  if (dot < 0) return "";
  return leaf.slice(dot + 1).toLowerCase();
}

export function readerKindFor(item: Pick<MessageRecord, "extracted_filename" | "extracted_url" | "type">): ReaderKind {
  const name = item.extracted_filename || item.extracted_url || "";
  const ext = extensionOf(name);
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "docx") return "docx";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (["mp3", "wav", "ogg", "m4a", "aac", "opus"].includes(ext)) return "audio";
  if (["mp4", "webm", "mov", "m4v"].includes(ext)) return "video";
  if (TEXT_EXT.has(ext)) return "text";
  if (item.type === "document" && !ext) return "text";
  return "unsupported";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Small markdown → HTML converter for library reading (no dependency). */
export function markdownToHtml(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let inUl = false;
  let inOl = false;
  let para: string[] = [];

  const closeLists = () => {
    if (inUl) {
      html.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      html.push("</ol>");
      inOl = false;
    }
  };

  const flushPara = () => {
    if (!para.length) return;
    html.push(`<p>${para.join(" ")}</p>`);
    para = [];
  };

  const inline = (text: string): string => {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    out = out.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    );
    return out;
  };

  for (const raw of lines) {
    const line = raw;
    if (line.startsWith("```")) {
      if (inCode) {
        html.push(
          `<pre class="doc-code"><code data-lang="${escapeHtml(codeLang)}">${escapeHtml(codeBuf.join("\n"))}</code></pre>`,
        );
        inCode = false;
        codeBuf = [];
        codeLang = "";
      } else {
        flushPara();
        closeLists();
        inCode = true;
        codeLang = line.slice(3).trim();
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeLists();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      closeLists();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const ul = /^[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (inOl) {
        html.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        html.push("<ul>");
        inUl = true;
      }
      html.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      if (inUl) {
        html.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        html.push("<ol>");
        inOl = true;
      }
      html.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      flushPara();
      closeLists();
      html.push("<hr />");
      continue;
    }
    closeLists();
    para.push(inline(line.trim()));
  }
  flushPara();
  closeLists();
  if (inCode) {
    html.push(`<pre class="doc-code"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  }
  return html.join("\n");
}

async function fetchSigned(url: string, as: "text" | "blob" | "arrayBuffer"): Promise<string | Blob | ArrayBuffer> {
  const headers = new Headers();
  const token = getToken();
  // Signed URLs work without auth; bearer is a fallback for unsigned paths.
  if (token && !/[?&]sig=/.test(url)) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Could not load file (${res.status})`);
  if (as === "text") return res.text();
  if (as === "blob") return res.blob();
  return res.arrayBuffer();
}

function ReaderChrome({
  title,
  subtitle,
  kind,
  href,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  kind: ReaderKind;
  href: string | null;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-stretch justify-center bg-zinc-950/55 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-[#f7f4ec] shadow-2xl ring-1 ring-zinc-900/10"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-zinc-200 bg-white px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">{kind}</p>
            <h2 className="truncate text-sm font-semibold text-zinc-900" title={title}>
              {title}
            </h2>
            {subtitle ? <p className="truncate text-xs text-zinc-500">{subtitle}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                download
                className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
              >
                Download
              </a>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-zinc-900 px-2.5 py-1.5 text-xs text-white hover:bg-zinc-800"
            >
              Close
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}

export default function DocumentReader({
  item,
  onClose,
}: {
  item: MessageRecord;
  onClose: () => void;
}) {
  const kind = useMemo(() => readerKindFor(item), [item]);
  const href = item.extracted_url?.startsWith("/api/files/") || item.extracted_url?.startsWith("http")
    ? fileSrc(item.extracted_url)
    : null;
  const title = item.extracted_filename || "Document";
  const subtitle = [item.sender, formatWhen(item.timestamp)].filter(Boolean).join(" · ");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string>("");
  const [html, setHtml] = useState<string>("");
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      setText("");
      setHtml("");
      setObjectUrl(null);
      if (!href) {
        setError("No file is attached to this message.");
        setLoading(false);
        return;
      }
      try {
        if (kind === "pdf" || kind === "image" || kind === "audio" || kind === "video") {
          const blob = (await fetchSigned(href, "blob")) as Blob;
          if (cancelled) return;
          const typed =
            kind === "pdf"
              ? new Blob([blob], { type: "application/pdf" })
              : blob;
          const url = URL.createObjectURL(typed);
          revoked = url;
          setObjectUrl(url);
        } else if (kind === "markdown" || kind === "text") {
          const body = (await fetchSigned(href, "text")) as string;
          if (cancelled) return;
          if (kind === "markdown") setHtml(markdownToHtml(body));
          else setText(body);
        } else if (kind === "html") {
          const body = (await fetchSigned(href, "text")) as string;
          if (cancelled) return;
          setHtml(body);
        } else if (kind === "docx") {
          const buffer = (await fetchSigned(href, "arrayBuffer")) as ArrayBuffer;
          if (cancelled) return;
          const mammothMod = await import("mammoth");
          const result = await mammothMod.convertToHtml({ arrayBuffer: buffer });
          if (cancelled) return;
          setHtml(result.value || "<p><em>Empty document.</em></p>");
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not open file");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [href, kind]);

  return (
    <ReaderChrome title={title} subtitle={subtitle} kind={kind} href={href} onClose={onClose}>
      {loading ? (
        <div className="flex h-full min-h-[320px] items-center justify-center text-sm text-zinc-500">Loading…</div>
      ) : error ? (
        <div className="space-y-3 p-6 text-sm text-zinc-700">
          <p className="text-red-700">{error}</p>
          {href ? (
            <a href={href} target="_blank" rel="noreferrer" className="font-medium text-emerald-700 hover:underline">
              Open / download instead
            </a>
          ) : null}
        </div>
      ) : kind === "pdf" && objectUrl ? (
        <iframe title={title} src={objectUrl} className="h-[min(80vh,900px)] w-full border-0 bg-zinc-200" />
      ) : kind === "image" && objectUrl ? (
        <div className="flex min-h-[320px] items-center justify-center bg-zinc-100 p-4">
          <img src={objectUrl} alt={title} className="max-h-[80vh] max-w-full object-contain" />
        </div>
      ) : kind === "audio" && objectUrl ? (
        <div className="flex min-h-[200px] items-center justify-center p-8">
          <audio src={objectUrl} controls className="w-full max-w-xl" />
        </div>
      ) : kind === "video" && objectUrl ? (
        <div className="flex min-h-[320px] items-center justify-center bg-black p-2">
          <video src={objectUrl} controls className="max-h-[80vh] w-full" />
        </div>
      ) : kind === "markdown" || kind === "docx" ? (
        <article
          className="doc-reader prose-doc mx-auto max-w-3xl px-5 py-6 text-[15px] leading-7 text-zinc-800"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : kind === "html" ? (
        <iframe title={title} srcDoc={html} sandbox="" className="h-[min(80vh,900px)] w-full border-0 bg-white" />
      ) : kind === "text" ? (
        <pre className="overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-[13px] leading-6 text-zinc-800">
          {text}
        </pre>
      ) : (
        <div className="space-y-3 p-6 text-sm text-zinc-700">
          <p>In-app preview isn’t available for this file type yet.</p>
          {href ? (
            <a href={href} target="_blank" rel="noreferrer" className="font-medium text-emerald-700 hover:underline">
              Open / download file
            </a>
          ) : null}
        </div>
      )}
      <style>{`
        .prose-doc h1 {
          font-size: 1.75rem;
          font-weight: 700;
          margin: 0 0 0.75rem;
        }
        .prose-doc h2 {
          font-size: 1.35rem;
          font-weight: 700;
          margin: 1.25rem 0 0.5rem;
        }
        .prose-doc h3,
        .prose-doc h4 {
          font-size: 1.1rem;
          font-weight: 600;
          margin: 1rem 0 0.4rem;
        }
        .prose-doc p {
          margin: 0 0 0.85rem;
        }
        .prose-doc ul,
        .prose-doc ol {
          margin: 0 0 0.85rem;
          padding-left: 1.35rem;
        }
        .prose-doc li {
          margin: 0.2rem 0;
        }
        .prose-doc a {
          color: #047857;
          text-decoration: underline;
        }
        .prose-doc code {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 0.85em;
          background: #efe9dc;
          padding: 0.1rem 0.35rem;
          border-radius: 0.25rem;
        }
        .prose-doc pre.doc-code,
        .prose-doc pre {
          background: #1f2937;
          color: #f3f4f6;
          padding: 0.85rem 1rem;
          border-radius: 0.75rem;
          overflow: auto;
          margin: 0 0 1rem;
        }
        .prose-doc pre code {
          background: transparent;
          padding: 0;
          color: inherit;
        }
        .prose-doc hr {
          border: 0;
          border-top: 1px solid #d4d4d8;
          margin: 1.25rem 0;
        }
        .prose-doc img {
          max-width: 100%;
          border-radius: 0.5rem;
        }
        .prose-doc table {
          width: 100%;
          border-collapse: collapse;
          margin: 0 0 1rem;
          font-size: 0.9rem;
        }
        .prose-doc th,
        .prose-doc td {
          border: 1px solid #d4d4d8;
          padding: 0.4rem 0.55rem;
          text-align: left;
        }
      `}</style>
    </ReaderChrome>
  );
}
