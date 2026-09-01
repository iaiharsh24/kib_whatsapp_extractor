"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { saveMessageTags, uniqueTags } from "@/lib/tags";

export default function TagEditor({
  tags,
  knownTags = [],
  disabled,
  messageId,
  onChange,
}: {
  tags: string[];
  knownTags?: string[];
  disabled?: boolean;
  messageId?: string;
  onChange?: (tags: string[]) => void;
}) {
  const listId = useId();
  const [draft, setDraft] = useState("");
  const incoming = uniqueTags(tags);
  const incomingKey = incoming.join("\0");
  const [pending, setPending] = useState<string[] | null>(null);
  const current = pending ?? incoming;
  const suggestions = useMemo(() => {
    const have = new Set(current.map((tag) => tag.toLowerCase()));
    return knownTags.filter((tag) => !have.has(tag.toLowerCase())).slice(0, 20);
  }, [current, knownTags]);

  useEffect(() => {
    if (pending && pending.join("\0") === incomingKey) setPending(null);
  }, [incomingKey, pending]);

  async function commit(next: string[]) {
    const cleaned = uniqueTags(next);
    setPending(cleaned);
    onChange?.(cleaned);
    if (!messageId) {
      setPending(null);
      return;
    }
    try {
      await saveMessageTags(messageId, cleaned);
    } catch {
      setPending(null);
    }
  }

  function add(raw: string) {
    const name = raw.trim();
    if (!name) return;
    setDraft("");
    void commit([...current, name]);
  }

  return (
    <div
      className="nodrag nopan nowheel"
      draggable={false}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="flex flex-wrap items-center gap-1">
        {current.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-800">
            {tag}
            {disabled ? null : (
              <button
                type="button"
                title={`Remove ${tag}`}
                onClick={() => void commit(current.filter((item) => item.toLowerCase() !== tag.toLowerCase()))}
                className="text-emerald-700 hover:text-red-600"
              >
                x
              </button>
            )}
          </span>
        ))}
        {disabled ? null : (
          <input
            value={draft}
            list={listId}
            placeholder="+ tag"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                add(draft.replace(/,/g, ""));
              }
            }}
            onBlur={() => {
              if (draft.trim()) add(draft);
            }}
            className="min-w-16 flex-1 bg-transparent text-[11px] outline-none placeholder:text-zinc-400"
          />
        )}
      </div>
      <datalist id={listId}>
        {suggestions.map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
    </div>
  );
}
