"use client";

import { memo, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { fileSrc, formatWhen } from "@/lib/api";
import { InstagramReelEmbed, captionText, isInstagramEmbed } from "@/components/MediaPreview";
import DocumentReader, { extensionOf, readerKindFor } from "@/components/DocumentReader";
import TagEditor from "@/components/TagEditor";
import type { MessageRecord } from "@/lib/types";
import { useCanvasEdit } from "./CanvasContext";
import { visibleTags } from "@/lib/tags";

function Resizer({ selected, locked }: { selected?: boolean; locked?: boolean }) {
  if (locked) return null;
  return (
    <NodeResizer
      minWidth={120}
      minHeight={72}
      isVisible={!!selected}
      color="#4262ff"
      handleClassName="canvas-resize-handle"
      lineClassName="canvas-resize-line"
    />
  );
}

function NodeHandles() {
  return (
    <>
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[#4262ff]" />
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[#4262ff]" />
      <Handle type="target" position={Position.Top} id="t" className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[#4262ff]" />
      <Handle type="source" position={Position.Bottom} id="b" className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[#4262ff]" />
    </>
  );
}

/** Fill the React Flow node box (which NodeResizer sizes). RF hosts are position:absolute. */
function NodeShell({
  className,
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={`canvas-node-shell box-border overflow-hidden ${className || ""}`}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export const ItemNode = memo(function ItemNode({ id, data, selected }: NodeProps) {
  const { setNodeTags, knownTags } = useCanvasEdit();
  const [readerOpen, setReaderOpen] = useState(false);
  const item = data as {
    messageId?: string;
    type?: string;
    sender?: string;
    text?: string;
    url?: string;
    filename?: string | null;
    previewImage?: string | null;
    previewTitle?: string | null;
    embed?: string | null;
    timestamp?: string | null;
    locked?: boolean;
    tags?: string[];
  };
  const local = item.url && item.url.startsWith("/api/files/") ? fileSrc(item.url) : null;
  const isReel = item.type === "reel";
  const isImage = item.type === "image" || item.type === "media_omitted";
  const isDoc = item.type === "document";
  const filename =
    item.filename ||
    (item.url ? decodeURIComponent((item.url.split("?")[0].split("/").pop() || "").trim()) : "") ||
    null;
  const readerItem = useMemo<MessageRecord | null>(() => {
    if (!isDoc) return null;
    return {
      id: item.messageId || id,
      upload_id: "",
      sender: item.sender || "Unknown",
      timestamp: item.timestamp || null,
      raw_text: item.text || "",
      type: "document",
      extracted_url: item.url || null,
      extracted_filename: filename,
      context_before: null,
      context_after: null,
      chat_name: null,
      tags: item.tags || [],
      link_preview: null,
      urls: [],
    };
  }, [filename, id, isDoc, item.messageId, item.sender, item.tags, item.text, item.timestamp, item.url]);
  const docKind = readerItem ? readerKindFor(readerItem) : "unsupported";
  const docExt = extensionOf(filename || item.url || "").toUpperCase() || "DOC";
  const localImage = local && isImage ? local : null;
  const remoteImage =
    item.previewImage && !item.previewImage.includes("google.com/s2/favicons") ? item.previewImage : null;
  const imageSrc = localImage || remoteImage;
  const videoSrc = local && isReel && /\.(mp4|webm|mov)$/i.test(item.url || "") ? local : null;
  const instagramSrc =
    (item.embed && isInstagramEmbed(item.embed) ? item.embed : null) ||
    (item.url && isInstagramEmbed(item.url) ? item.url : null);
  const caption = captionText({
    raw_text: item.text || "",
    extracted_url: item.url || null,
    extracted_filename: filename,
    urls: [],
  });
  const hasMedia = !!(videoSrc || (isReel && instagramSrc) || (isReel && item.embed) || imageSrc || isReel);

  return (
    <>
      <Resizer selected={selected} locked={item.locked} />
      <NodeHandles />
      <NodeShell
        className={`flex flex-col bg-white shadow-sm ${
          selected ? "border-2 border-[#4262ff]" : "border border-zinc-300"
        } rounded-xl`}
      >
        {videoSrc ? (
          <div className="relative min-h-0 w-full flex-1 bg-black">
            <video src={videoSrc} muted loop playsInline autoPlay className="absolute inset-0 h-full w-full object-contain" />
          </div>
        ) : isReel && instagramSrc ? (
          <div className="relative min-h-0 w-full flex-1 overflow-hidden bg-black">
            <InstagramReelEmbed src={instagramSrc} interactive />
          </div>
        ) : isReel && item.embed && !isInstagramEmbed(item.embed) ? (
          <div className="relative min-h-0 w-full flex-1 bg-black">
            <iframe
              title={item.previewTitle || "reel"}
              src={item.embed}
              className="absolute inset-0 h-full w-full border-0"
              allow="autoplay; encrypted-media; picture-in-picture"
            />
          </div>
        ) : imageSrc ? (
          <div className="relative min-h-0 w-full flex-1 bg-black">
            <img src={imageSrc} alt="" className="absolute inset-0 h-full w-full object-contain" />
          </div>
        ) : isDoc && local ? (
          <button
            type="button"
            className="nodrag nowheel nopan relative flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 bg-amber-50 px-3 text-center hover:bg-amber-100"
            onClick={() => setReaderOpen(true)}
            title="Open in reader"
          >
            <span className="rounded-md bg-amber-200/80 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-900">
              {docExt}
            </span>
            <span className="line-clamp-2 text-xs font-medium text-amber-950">{filename || "Document"}</span>
            <span className="text-[10px] font-semibold text-emerald-700">Open in reader →</span>
          </button>
        ) : isReel ? (
          <div className="flex min-h-0 w-full flex-1 items-center justify-center bg-gradient-to-br from-purple-600 via-pink-500 to-orange-400 px-3 text-center text-sm font-semibold text-white">
            {item.previewTitle || "Reel"}
          </div>
        ) : null}
        <div className={`min-h-0 overflow-auto p-3 ${hasMedia || (isDoc && local) ? "flex-none" : "flex-1"}`}>
          <p className="text-[10px] uppercase tracking-wide text-emerald-700">{item.type}</p>
          <p className="text-sm font-semibold">{item.sender}</p>
          <p className="text-[10px] text-zinc-500">{formatWhen(item.timestamp)}</p>
          {item.previewTitle && item.previewTitle !== item.sender ? (
            <p className="mt-1 line-clamp-2 text-xs font-medium text-zinc-700">{item.previewTitle}</p>
          ) : null}
          {caption ? <p className="mt-1 line-clamp-3 text-xs text-zinc-600">{caption}</p> : null}
          {isDoc && filename ? <p className="mt-1 truncate text-[11px] text-zinc-500">{filename}</p> : null}
          {isDoc && local ? (
            <button
              type="button"
              className="nodrag nowheel nopan mt-1 text-[11px] font-medium text-emerald-700 hover:underline"
              onClick={() => setReaderOpen(true)}
            >
              Open in reader ({docKind})
            </button>
          ) : null}
          {item.url && item.url.startsWith("http") ? (
            <p className="mt-1 truncate text-[11px] text-emerald-700">{item.url}</p>
          ) : null}
          <div className="mt-2 border-t border-zinc-100 pt-2">
            <TagEditor
              tags={visibleTags(item.tags)}
              knownTags={knownTags}
              disabled={item.locked}
              messageId={item.messageId}
              onChange={(tags) => setNodeTags(id, tags)}
            />
          </div>
        </div>
      </NodeShell>
      {readerOpen && readerItem ? <DocumentReader item={readerItem} onClose={() => setReaderOpen(false)} /> : null}
    </>
  );
});

export const NoteNode = memo(function NoteNode({ id, data, selected }: NodeProps) {
  const item = data as { text?: string; color?: string; locked?: boolean; tags?: string[] };
  const { patchNode, setNodeTags, knownTags } = useCanvasEdit();
  const dark = item.color === "#1f2937";
  return (
    <>
      <Resizer selected={selected} locked={item.locked} />
      <NodeHandles />
      <NodeShell
        className={`flex flex-col rounded-md p-3 shadow-sm ${selected ? "ring-2 ring-[#4262ff]" : ""}`}
        style={{ background: item.color || "#fde68a", color: dark ? "#f8fafc" : "#18181b" }}
      >
        <textarea
          value={item.text || ""}
          disabled={item.locked}
          onChange={(event) => patchNode(id, { text: event.target.value })}
          placeholder="Sticky note"
          className="nodrag nowheel nopan min-h-0 w-full flex-1 resize-none bg-transparent text-sm outline-none"
        />
        <div className={`mt-2 border-t pt-2 ${dark ? "border-white/20" : "border-black/10"}`}>
          <TagEditor
            tags={visibleTags(item.tags)}
            knownTags={knownTags}
            disabled={item.locked}
            onChange={(tags) => setNodeTags(id, tags)}
          />
        </div>
      </NodeShell>
    </>
  );
});

export const FrameNode = memo(function FrameNode({ id, data, selected }: NodeProps) {
  const item = data as { label?: string; color?: string; locked?: boolean };
  const { patchNode } = useCanvasEdit();
  return (
    <>
      <Resizer selected={selected} locked={item.locked} />
      <NodeShell
        className={`rounded-2xl border-2 border-dashed p-3 ${selected ? "shadow-[0_0_0_2px_#4262ff]" : ""}`}
        style={{
          borderColor: item.color || "#0f766e66",
          background: `${item.color || "#0f766e"}14`,
        }}
      >
        <input
          value={item.label || ""}
          disabled={item.locked}
          onChange={(event) => patchNode(id, { label: event.target.value })}
          placeholder="Frame label"
          className="nodrag nowheel nopan w-full bg-transparent text-sm font-semibold outline-none"
        />
      </NodeShell>
    </>
  );
});

export const TextNode = memo(function TextNode({ id, data, selected }: NodeProps) {
  const item = data as { text?: string; color?: string; fontSize?: number; locked?: boolean };
  const { patchNode } = useCanvasEdit();
  return (
    <>
      <Resizer selected={selected} locked={item.locked} />
      <NodeHandles />
      <NodeShell className={`p-1 ${selected ? "shadow-[0_0_0_2px_#4262ff]" : ""}`}>
        <textarea
          value={item.text || ""}
          disabled={item.locked}
          onChange={(event) => patchNode(id, { text: event.target.value })}
          placeholder="Type..."
          className="nodrag nowheel nopan h-full w-full resize-none bg-transparent font-medium outline-none"
          style={{ color: item.color || "#18181b", fontSize: item.fontSize || 20 }}
        />
      </NodeShell>
    </>
  );
});

export const ShapeNode = memo(function ShapeNode({ id, data, selected }: NodeProps) {
  const item = data as { text?: string; color?: string; shape?: string; locked?: boolean };
  const { patchNode } = useCanvasEdit();
  const color = item.color || "#bfdbfe";
  const dark = color === "#1f2937";
  const shape = item.shape || "rect";
  const radius = shape === "ellipse" ? "999px" : shape === "round" ? "24px" : "8px";
  return (
    <>
      <Resizer selected={selected} locked={item.locked} />
      <NodeHandles />
      <NodeShell
        className="flex items-center justify-center p-3 shadow-sm"
        style={{
          background: color,
          color: dark ? "#f8fafc" : "#18181b",
          borderRadius: shape === "diamond" ? 0 : radius,
          transform: shape === "diamond" ? "rotate(45deg)" : undefined,
          boxShadow: selected ? "0 0 0 2px #4262ff" : undefined,
        }}
      >
        <textarea
          value={item.text || ""}
          disabled={item.locked}
          onChange={(event) => patchNode(id, { text: event.target.value })}
          placeholder="Text"
          className="nodrag nowheel nopan h-full w-full resize-none bg-transparent text-center text-sm font-medium outline-none"
          style={{ transform: shape === "diamond" ? "rotate(-45deg)" : undefined }}
        />
      </NodeShell>
    </>
  );
});

export const CommentNode = memo(function CommentNode({ id, data, selected }: NodeProps) {
  const item = data as { text?: string; locked?: boolean };
  const { patchNode } = useCanvasEdit();
  return (
    <>
      <Resizer selected={selected} locked={item.locked} />
      <NodeHandles />
      <NodeShell
        className={`flex flex-col border border-amber-300 bg-amber-50 p-2 shadow-sm ${
          selected ? "ring-2 ring-[#4262ff]" : ""
        } rounded-xl`}
      >
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700">Comment</p>
        <textarea
          value={item.text || ""}
          disabled={item.locked}
          onChange={(event) => patchNode(id, { text: event.target.value })}
          placeholder="Add a comment"
          className="nodrag nowheel nopan min-h-0 w-full flex-1 resize-none bg-transparent text-sm outline-none"
        />
      </NodeShell>
    </>
  );
});

export const DrawNode = memo(function DrawNode({ data, selected }: NodeProps) {
  const item = data as {
    points?: { x: number; y: number }[];
    color?: string;
    width?: number;
    height?: number;
    kind?: string;
    locked?: boolean;
  };
  const points = item.points || [];
  const d = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const highlight = item.kind === "highlight";
  return (
    <>
      <Resizer selected={selected} locked={item.locked} />
      <NodeShell>
        <svg className="h-full w-full overflow-visible" viewBox={`0 0 ${item.width || 100} ${item.height || 100}`}>
          <path
            d={d}
            fill="none"
            stroke={item.color || "#18181b"}
            strokeWidth={highlight ? 18 : 3}
            strokeOpacity={highlight ? 0.4 : 1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {selected ? <div className="pointer-events-none absolute inset-0 ring-2 ring-[#4262ff]" /> : null}
      </NodeShell>
    </>
  );
});

export const GroupNode = memo(function GroupNode({ id, data, selected }: NodeProps) {
  const item = data as { label?: string; locked?: boolean };
  const { patchNode } = useCanvasEdit();
  return (
    <>
      <Resizer selected={selected} locked={item.locked} />
      <NodeShell
        className={`rounded-xl border-2 border-dashed bg-white/50 p-2 ${
          selected ? "border-[#4262ff]" : "border-zinc-300"
        }`}
      >
        <input
          value={item.label || ""}
          disabled={item.locked}
          onChange={(event) => patchNode(id, { label: event.target.value })}
          placeholder="Group"
          className="nodrag nowheel nopan w-full bg-transparent text-xs font-semibold text-zinc-500 outline-none"
        />
      </NodeShell>
    </>
  );
});

export const nodeTypes = {
  item: ItemNode,
  note: NoteNode,
  frame: FrameNode,
  text: TextNode,
  shape: ShapeNode,
  comment: CommentNode,
  draw: DrawNode,
  group: GroupNode,
};
