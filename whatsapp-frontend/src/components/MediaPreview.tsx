"use client";

import { useRef } from "react";
import { fileSrc, formatWhen } from "@/lib/api";
import type { MessageRecord } from "@/lib/types";
import TagEditor from "@/components/TagEditor";
import { visibleTags } from "@/lib/tags";

export function isLocalFile(url?: string | null): boolean {
  return !!url && url.startsWith("/api/files/");
}

export function isImageMessage(item: MessageRecord): boolean {
  const name = (item.extracted_filename || item.extracted_url || "").toLowerCase();
  return item.type === "image" || item.type === "media_omitted" || /\.(jpg|jpeg|png|gif|webp)$/i.test(name);
}

export function isVideoMessage(item: MessageRecord): boolean {
  const name = (item.extracted_filename || item.extracted_url || "").toLowerCase();
  return item.type === "reel" || /\.(mp4|webm|mov)$/i.test(name);
}

export function captionText(
  item: Pick<MessageRecord, "raw_text" | "extracted_url" | "extracted_filename" | "urls">,
): string {
  let text = (item.raw_text || "").trim();
  const urls = [...(item.urls || [])];
  if (item.extracted_url && /^https?:\/\//i.test(item.extracted_url)) urls.push(item.extracted_url);
  for (const url of urls) {
    if (url) text = text.split(url).join(" ");
  }
  text = text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/<attached:\s*[^>]+>/gi, " ")
    .replace(/\b(image|video|audio|gif|sticker) omitted\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (item.extracted_filename && text === item.extracted_filename) return "";
  return text;
}

export function ItemMeta({
  item,
  editable,
  knownTags = [],
}: {
  item: Pick<
    MessageRecord,
    "id" | "sender" | "timestamp" | "raw_text" | "extracted_url" | "extracted_filename" | "urls" | "tags" | "type"
  >;
  editable?: boolean;
  knownTags?: string[];
}) {
  const caption = captionText(item);
  const tags = visibleTags(item.tags);
  return (
    <div className="space-y-0.5 bg-white px-2 py-1.5">
      <p className="truncate text-[11px] font-medium text-zinc-900">{item.sender || "Unknown"}</p>
      <p className="truncate text-[10px] text-zinc-500">{formatWhen(item.timestamp)}</p>
      {item.extracted_filename ? <p className="truncate text-[10px] text-zinc-500">{item.extracted_filename}</p> : null}
      {caption ? <p className="line-clamp-3 text-[11px] text-zinc-600">{caption}</p> : null}
      {editable ? (
        <div className="pt-1">
          <TagEditor tags={tags} knownTags={knownTags} messageId={item.id} />
        </div>
      ) : tags.length ? (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {tags.map((tag) => (
            <span key={tag} className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HoverVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  return (
    <video
      ref={ref}
      src={src}
      muted
      loop
      playsInline
      autoPlay
      preload="metadata"
      className="h-full w-full object-contain"
      onMouseEnter={() => void ref.current?.play().catch(() => undefined)}
    />
  );
}

export function instagramBareEmbed(url: string): string {
  const match = url.match(/instagram\.com\/(reel|p|tv)\/([A-Za-z0-9_-]+)/i);
  if (match) {
    const kind = match[1].toLowerCase() === "p" ? "p" : "reel";
    return `https://www.instagram.com/${kind}/${match[2]}/embed/?hidecaption=1`;
  }
  const cleaned = url.replace(/\/embed\/captioned\/?/i, "/embed/").split("#")[0];
  return cleaned.includes("hidecaption") ? cleaned : `${cleaned}${cleaned.includes("?") ? "&" : "?"}hidecaption=1`;
}

export function isInstagramEmbed(url?: string | null): boolean {
  return !!url && /instagram\.com/i.test(url);
}

export function InstagramReelEmbed({
  src,
  interactive = false,
}: {
  src: string;
  interactive?: boolean;
}) {
  return (
    <div
      className="absolute inset-0 overflow-hidden bg-black"
      style={{ isolation: "isolate", contain: "paint", clipPath: "inset(0)", transform: "translateZ(0)" }}
    >
      <iframe
        title="Instagram reel"
        src={instagramBareEmbed(src)}
        scrolling="no"
        allow="autoplay; encrypted-media; picture-in-picture"
        className={`absolute inset-0 h-full w-full border-0 ${interactive ? "" : "pointer-events-none"}`}
        style={{
          transform: "scale(2.3)",
          transformOrigin: "center 12%",
        }}
      />
    </div>
  );
}

export function MediaFrame({
  item,
  kind,
}: {
  item: Pick<MessageRecord, "type" | "extracted_url" | "extracted_filename" | "link_preview" | "urls">;
  kind: "image" | "reel";
}) {
  const local = isLocalFile(item.extracted_url) ? fileSrc(item.extracted_url) : null;
  const preview = item.link_preview;
  const embed = preview?.embed;
  const portrait = kind === "reel";
  const instagramSrc =
    (embed && isInstagramEmbed(embed) ? embed : null) ||
    (isInstagramEmbed(item.extracted_url) ? item.extracted_url : null) ||
    (item.urls || []).find((url) => isInstagramEmbed(url)) ||
    (preview?.url && isInstagramEmbed(preview.url) ? preview.url : null);

  return (
    <div className={`relative w-full overflow-hidden bg-black ${portrait ? "aspect-[9/16]" : "aspect-[4/5]"}`}>
      {local && kind === "reel" && isVideoMessage(item as MessageRecord) ? (
        <HoverVideo src={local} />
      ) : local && (kind === "image" || isImageMessage(item as MessageRecord)) ? (
        <img src={local} alt="" loading="lazy" className="h-full w-full object-contain" />
      ) : instagramSrc && kind === "reel" ? (
        <InstagramReelEmbed src={instagramSrc} />
      ) : embed && kind === "reel" && !isInstagramEmbed(embed) ? (
        <iframe
          title={preview?.title || "reel"}
          src={embed}
          className="absolute inset-0 h-full w-full border-0"
          allow="autoplay; encrypted-media; picture-in-picture"
        />
      ) : preview?.image && !preview.image.includes("google.com/s2/favicons") ? (
        <img src={preview.image} alt="" className="h-full w-full object-contain" />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-purple-600 via-pink-500 to-orange-400 px-3 text-center text-white">
          <p className="text-sm font-semibold">{preview?.title || (kind === "reel" ? "Reel" : "Image")}</p>
        </div>
      )}
    </div>
  );
}
