"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { getPreference, loadPreferences, savePreference } from "@/lib/preferences";
import type { ChatEntry } from "@/lib/types";

export default function ProjectChat({ projectId }: { projectId: string }) {
  const [question, setQuestion] = useState("");
  const [log, setLog] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    void loadPreferences().then(() => setOpen(getPreference<boolean>("ai_collapsed", false) !== true));
    void api<ChatEntry[]>(`/api/projects/${projectId}/chat`)
      .then(setLog)
      .catch(() => setLog([]));
  }, [projectId]);

  function toggle() {
    setOpen((current) => {
      const next = !current;
      void savePreference("ai_collapsed", !next);
      return next;
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!question.trim()) return;
    const asked = question.trim();
    setQuestion("");
    setLog((current) => [...current, { role: "user", text: asked }]);
    setBusy(true);
    try {
      const result = await api<{ answer: string }>(`/api/projects/${projectId}/chat`, {
        method: "POST",
        body: JSON.stringify({ question: asked }),
      });
      setLog((current) => [...current, { role: "assistant", text: result.answer }]);
    } catch (err) {
      setLog((current) => [
        ...current,
        { role: "assistant", text: err instanceof Error ? err.message : "Chat failed" },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-zinc-200 bg-white transition-[width] duration-200 ${
        open ? "w-80" : "w-10"
      }`}
    >
      <button
        type="button"
        onClick={toggle}
        title={open ? "Collapse Project AI" : "Expand Project AI"}
        className={`border-b border-zinc-200 text-left hover:bg-zinc-50 ${open ? "px-3 py-2" : "px-0 py-3"}`}
      >
        {open ? (
          <span className="flex items-start justify-between gap-2">
            <span>
              <p className="text-sm font-semibold">Project AI</p>
              <p className="text-[11px] text-zinc-500">Reads only this board, its links, and the source chats on it.</p>
            </span>
            <Chevron dir="right" />
          </span>
        ) : (
          <span className="flex justify-center text-zinc-500">
            <Chevron dir="left" />
          </span>
        )}
      </button>
      {open ? (
        <>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-sm">
            {log.length === 0 ? (
              <p className="text-zinc-500">
                Try: Summarize the strategy on this board. Or: What are the missing links?
              </p>
            ) : (
              log.map((entry, index) => (
                <div key={index} className={entry.role === "user" ? "text-zinc-900" : "whitespace-pre-wrap text-zinc-700"}>
                  <p className="text-[10px] uppercase text-zinc-400">{entry.role}</p>
                  {entry.text}
                </div>
              ))
            )}
          </div>
          <form onSubmit={onSubmit} className="border-t border-zinc-200 p-3">
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              rows={3}
              placeholder="Ask about this project..."
              className="w-full rounded-md border border-zinc-300 p-2 text-sm"
            />
            <button
              type="submit"
              disabled={busy}
              className="mt-2 w-full rounded-md bg-zinc-900 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {busy ? "Thinking..." : "Send"}
            </button>
          </form>
        </>
      ) : (
        <button
          type="button"
          onClick={toggle}
          className="flex flex-1 items-center justify-center text-[11px] uppercase tracking-wide text-zinc-500"
          title="Expand Project AI"
        >
          <span className="rotate-90 whitespace-nowrap">Project AI</span>
        </button>
      )}
    </div>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="1.8">
      {dir === "left" ? <path d="M12.5 5 L7.5 10 L12.5 15" /> : <path d="M7.5 5 L12.5 10 L7.5 15" />}
    </svg>
  );
}
