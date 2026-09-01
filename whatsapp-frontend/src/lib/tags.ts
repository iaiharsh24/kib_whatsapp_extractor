import { api } from "@/lib/api";
import type { MessageRecord } from "@/lib/types";

export const TYPE_TAGS = new Set(["chat", "link", "document", "reel", "image", "media_omitted"]);
export const TAGS_EVENT = "wa-message-tags";

export function cleanTag(raw: string) {
  return raw.trim().replace(/\s+/g, " ").slice(0, 40);
}

export function uniqueTags(tags: string[] | undefined | null) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of tags || []) {
    const name = cleanTag(String(item || ""));
    if (!name || TYPE_TAGS.has(name.toLowerCase())) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(name);
  }
  return next;
}

export function visibleTags(tags: string[] | undefined | null) {
  return uniqueTags(tags);
}

export function emitMessageTags(messageId: string, tags: string[]) {
  window.dispatchEvent(new CustomEvent(TAGS_EVENT, { detail: { messageId, tags: uniqueTags(tags) } }));
}

export async function saveMessageTags(messageId: string, tags: string[]) {
  const updated = await api<MessageRecord>(`/api/messages/${messageId}/tags`, {
    method: "PATCH",
    body: JSON.stringify({ tags: uniqueTags(tags) }),
  });
  const next = visibleTags(updated.tags);
  emitMessageTags(messageId, next);
  return next;
}
