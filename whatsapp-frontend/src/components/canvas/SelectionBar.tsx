"use client";

import TagEditor from "@/components/TagEditor";
import { BOARD_COLORS } from "./CanvasContext";

export default function SelectionBar({
  count,
  locked,
  canGroup,
  canUngroup,
  showTags,
  tags,
  knownTags,
  onDuplicate,
  onDelete,
  onLock,
  onFront,
  onBack,
  onAlign,
  onDistribute,
  onGroup,
  onUngroup,
  onColor,
  onFont,
  onTags,
}: {
  count: number;
  locked: boolean;
  canGroup: boolean;
  canUngroup: boolean;
  showTags: boolean;
  tags: string[];
  knownTags: string[];
  onDuplicate: () => void;
  onDelete: () => void;
  onLock: () => void;
  onFront: () => void;
  onBack: () => void;
  onAlign: (dir: "left" | "center" | "right" | "top" | "middle" | "bottom") => void;
  onDistribute: (dir: "h" | "v") => void;
  onGroup: () => void;
  onUngroup: () => void;
  onColor: (color: string) => void;
  onFont: (size: number) => void;
  onTags: (tags: string[]) => void;
}) {
  if (count === 0) return null;
  return (
    <div className="pointer-events-auto absolute left-1/2 top-3 z-20 flex max-w-[min(720px,calc(100%-16rem))] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-xl border border-black/8 bg-white px-2 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
      {BOARD_COLORS.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onColor(value)}
          className="h-5 w-5 rounded-full border border-zinc-300"
          style={{ background: value }}
        />
      ))}
      <span className="mx-1 h-5 w-px bg-zinc-200" />
      {[14, 18, 24, 32].map((size) => (
        <button key={size} type="button" onClick={() => onFont(size)} className="rounded-md px-1.5 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100">
          {size}
        </button>
      ))}
      {showTags ? (
        <>
          <span className="mx-1 h-5 w-px bg-zinc-200" />
          <div className="min-w-40 max-w-64">
            <TagEditor tags={tags} knownTags={knownTags} disabled={locked} onChange={onTags} />
          </div>
        </>
      ) : null}
      {count > 1 ? (
        <>
          <span className="mx-1 h-5 w-px bg-zinc-200" />
          {(["left", "center", "right"] as const).map((dir) => (
            <button key={dir} type="button" onClick={() => onAlign(dir)} className="rounded-md px-1.5 py-1 text-[11px] capitalize text-zinc-600 hover:bg-zinc-100">
              {dir}
            </button>
          ))}
          <button type="button" onClick={() => onDistribute("h")} className="rounded-md px-1.5 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100">
            Dist H
          </button>
          <button type="button" onClick={() => onDistribute("v")} className="rounded-md px-1.5 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100">
            Dist V
          </button>
        </>
      ) : null}
      {canGroup ? (
        <button type="button" onClick={onGroup} className="rounded-md px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100">
          Group
        </button>
      ) : null}
      {canUngroup ? (
        <button type="button" onClick={onUngroup} className="rounded-md px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100">
          Ungroup
        </button>
      ) : null}
      <button type="button" onClick={onDuplicate} className="rounded-md px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100">
        Duplicate
      </button>
      <button type="button" onClick={onLock} className="rounded-md px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100">
        {locked ? "Unlock" : "Lock"}
      </button>
      <button type="button" onClick={onFront} className="rounded-md px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100">
        Front
      </button>
      <button type="button" onClick={onBack} className="rounded-md px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100">
        Back
      </button>
      <button type="button" onClick={onDelete} className="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50">
        Delete
      </button>
    </div>
  );
}
