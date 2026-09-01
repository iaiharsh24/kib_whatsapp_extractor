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
  const [focused, setFocused] = useState(false);
  const incoming = uniqueTags(tags);
  const incomingKey = incoming.join("\0");
  const [pending, setPending] = useState<string[] | null>(null);
  const current = pending ?? incoming;
  const suggestions = useMemo(() => {
    const have = new Set(current.map((tag) => tag.toLowerCase()));
    const query = draft.trim().toLowerCase();
    return knownTags
      .filter((tag) => !have.has(tag.toLowerCase()))
      .filter((tag) => !query || tag.toLowerCase().includes(query))
      .slice(0, 12);
  }, [current, draft, knownTags]);

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
    const name = raw.trim().replace(/,/g, "");
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
          <div className="flex min-w-[120px] flex-1 items-center gap-1 rounded-md border border-dashed border-zinc-200 bg-zinc-50 px-2 py-1">
            <input
              value={draft}
              list={listId}
              placeholder="+ tag"
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => {
                event.stopPropagation();
                setFocused(true);
              }}
              onBlur={() => {
                setFocused(false);
                if (draft.trim()) add(draft);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter" || event.key === ",") {
                  event.preventDefault();
                  add(draft);
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft("");
                  (event.target as HTMLInputElement).blur();
                }
              }}
              className="nodrag nopan nowheel min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-zinc-400"
            />
            {draft.trim() ? (
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => add(draft)}
                className="shrink-0 rounded bg-emerald-700 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-800"
              >
                Add
              </button>
            ) : null}
          </div>
        )}
      </div>
      {!disabled && focused && suggestions.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => add(tag)}
              className="rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[10px] text-zinc-600 hover:border-emerald-400 hover:text-emerald-700"
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}
      <datalist id={listId}>
        {suggestions.map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
    </div>
  );
}
