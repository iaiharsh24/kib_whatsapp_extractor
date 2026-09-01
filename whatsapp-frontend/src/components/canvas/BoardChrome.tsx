"use client";

import { BOARD_TEMPLATES } from "./templates";
import type { CanvasHistoryEntry } from "@/lib/types";

export function HelperLines({ x, y }: { x: number | null; y: number | null }) {
  if (x === null && y === null) return null;
  return (
    <svg className="pointer-events-none absolute inset-0 z-[5] h-full w-full overflow-visible">
      {x !== null ? <line x1={x} y1={0} x2={x} y2="100%" stroke="#4262ff" strokeWidth={1} /> : null}
      {y !== null ? <line x1={0} y1={y} x2="100%" y2={y} stroke="#4262ff" strokeWidth={1} /> : null}
    </svg>
  );
}

export function BoardChrome({
  search,
  onSearch,
  onJumpSearch,
  tagFilter,
  onTagFilter,
  tagOptions,
  frames,
  onJumpFrame,
  history,
  onRestore,
  onTemplate,
  onExport,
  onDuplicate,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  search: string;
  onSearch: (value: string) => void;
  onJumpSearch: () => void;
  tagFilter: string;
  onTagFilter: (value: string) => void;
  tagOptions: string[];
  frames: { id: string; label: string }[];
  onJumpFrame: (id: string) => void;
  history: CanvasHistoryEntry[];
  onRestore: (index: number) => void;
  onTemplate: (id: string) => void;
  onExport: () => void;
  onDuplicate: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute right-3 top-3 z-20 flex max-w-[min(560px,calc(100%-7rem))] flex-wrap items-center justify-end gap-1">
      <button
        type="button"
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
        onClick={onUndo}
        className="h-8 rounded-lg border border-black/8 bg-white px-2 text-xs shadow-[0_2px_12px_rgba(0,0,0,0.12)] disabled:opacity-30 hover:bg-zinc-50"
      >
        Undo
      </button>
      <button
        type="button"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
        onClick={onRedo}
        className="h-8 rounded-lg border border-black/8 bg-white px-2 text-xs shadow-[0_2px_12px_rgba(0,0,0,0.12)] disabled:opacity-30 hover:bg-zinc-50"
      >
        Redo
      </button>
      <input
        id="board-search"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        placeholder="Search board"
        onKeyDown={(event) => {
          if (event.key === "Enter") onJumpSearch();
        }}
        className="h-8 w-36 rounded-lg border border-black/8 bg-white px-2 text-xs shadow-[0_2px_12px_rgba(0,0,0,0.12)] outline-none"
      />
      <select
        value={tagFilter}
        onChange={(event) => onTagFilter(event.target.value)}
        className="h-8 rounded-lg border border-black/8 bg-white px-2 text-xs shadow-[0_2px_12px_rgba(0,0,0,0.12)]"
        title="Filter by tag"
      >
        <option value="">All tags</option>
        {tagOptions.map((tag) => (
          <option key={tag} value={tag}>
            {tag}
          </option>
        ))}
      </select>
      {frames.length > 0 ? (
        <select
          defaultValue=""
          onChange={(event) => {
            if (event.target.value) onJumpFrame(event.target.value);
            event.target.value = "";
          }}
          className="h-8 max-w-36 rounded-lg border border-black/8 bg-white px-2 text-xs shadow-[0_2px_12px_rgba(0,0,0,0.12)]"
          title="Jump to frame"
        >
          <option value="">Frames</option>
          {frames.map((frame) => (
            <option key={frame.id} value={frame.id}>
              {frame.label}
            </option>
          ))}
        </select>
      ) : null}
      <select
        defaultValue=""
        onChange={(event) => {
          if (event.target.value) onTemplate(event.target.value);
          event.target.value = "";
        }}
        className="h-8 rounded-lg border border-black/8 bg-white px-2 text-xs shadow-[0_2px_12px_rgba(0,0,0,0.12)]"
        title="Insert template"
      >
        <option value="">Template</option>
        {BOARD_TEMPLATES.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </select>
      {history.length > 0 ? (
        <select
          defaultValue=""
          onChange={(event) => {
            if (event.target.value) onRestore(Number(event.target.value));
            event.target.value = "";
          }}
          className="h-8 max-w-36 rounded-lg border border-black/8 bg-white px-2 text-xs shadow-[0_2px_12px_rgba(0,0,0,0.12)]"
          title="Restore a saved version from local database"
        >
          <option value="">History</option>
          {history.map((item, index) => (
            <option key={item.id} value={index}>
              {item.at ? new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Saved"}
            </option>
          ))}
        </select>
      ) : null}
      <button type="button" onClick={onExport} className="h-8 rounded-lg border border-black/8 bg-white px-2 text-xs shadow-[0_2px_12px_rgba(0,0,0,0.12)] hover:bg-zinc-50">
        Export PNG
      </button>
      <button type="button" onClick={onDuplicate} className="h-8 rounded-lg border border-black/8 bg-white px-2 text-xs shadow-[0_2px_12px_rgba(0,0,0,0.12)] hover:bg-zinc-50">
        Duplicate board
      </button>
    </div>
  );
}
