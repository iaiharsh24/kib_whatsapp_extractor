"use client";

import type { CanvasTool, DrawMode, ShapeKind } from "./CanvasContext";

const TOOLS: { id: CanvasTool; label: string; key: string; icon: string }[] = [
  { id: "select", label: "Select", key: "V", icon: "cursor" },
  { id: "pan", label: "Hand", key: "H", icon: "hand" },
  { id: "sticky", label: "Sticky note", key: "N", icon: "sticky" },
  { id: "text", label: "Text", key: "T", icon: "text" },
  { id: "shape", label: "Shape", key: "S", icon: "shape" },
  { id: "connect", label: "Connector", key: "C", icon: "connect" },
  { id: "frame", label: "Frame", key: "F", icon: "frame" },
  { id: "draw", label: "Pen", key: "P", icon: "pen" },
];

function Icon({ name }: { name: string }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (name === "cursor") return <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]"><path {...common} d="M5 4 l13 8 -7 1.2 -2.2 6.8 z" /></svg>;
  if (name === "hand") return <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]"><path {...common} d="M8 11 V6 a1 1 0 0 1 2 0 v5 M12 10 V5 a1 1 0 0 1 2 0 v5 M16 11 V7 a1 1 0 0 1 2 0 v8 a5 5 0 0 1 -10 0 v-3" /></svg>;
  if (name === "sticky") return <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]"><path {...common} d="M6 5 h9 l3 3 v11 H6 z M15 5 v3 h3" /></svg>;
  if (name === "text") return <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]"><path {...common} d="M6 7 h12 M12 7 v10 M9 17 h6" /></svg>;
  if (name === "shape") return <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]"><rect {...common} x="5" y="6" width="14" height="12" rx="2" /></svg>;
  if (name === "connect") return <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]"><path {...common} d="M7 12 h10 M14 8 l4 4 -4 4" /></svg>;
  if (name === "frame") return <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]"><rect {...common} x="4" y="5" width="16" height="14" rx="1" strokeDasharray="3 2" /></svg>;
  return <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]"><path {...common} d="M5 19 c8 -2 10 -10 14 -14 M9 15 c1 -3 4 -6 7 -8" /></svg>;
}

export default function Toolbar({
  tool,
  drawMode,
  shape,
  color,
  onTool,
  onDrawMode,
  onShape,
  onColor,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  tool: CanvasTool;
  drawMode: DrawMode;
  shape: ShapeKind;
  color: string;
  onTool: (tool: CanvasTool) => void;
  onDrawMode: (mode: DrawMode) => void;
  onShape: (shape: ShapeKind) => void;
  onColor: (color: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <>
      <div className="pointer-events-auto absolute left-3 top-3 z-20 flex items-center gap-0.5 rounded-lg border border-black/8 bg-white p-0.5 shadow-[0_2px_12px_rgba(0,0,0,0.12)]">
        <button type="button" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo} className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 disabled:opacity-30 hover:bg-zinc-100">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 7 H5 v4" /><path d="M5 11 C8 6 14 5 18 9 C21 12 20 17 16 19" /></svg>
        </button>
        <button type="button" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo} className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 disabled:opacity-30 hover:bg-zinc-100">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 7 h4 v4" /><path d="M19 11 C16 6 10 5 6 9 C3 12 4 17 8 19" /></svg>
        </button>
      </div>
      <div className="pointer-events-auto absolute left-3 top-1/2 z-20 -translate-y-1/2 rounded-2xl border border-black/8 bg-white p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
        {TOOLS.map((item) => (
          <button
            key={item.id}
            type="button"
            title={`${item.label} (${item.key})`}
            onClick={() => onTool(item.id)}
            className={`mb-1 flex h-10 w-10 items-center justify-center rounded-xl last:mb-0 ${
              tool === item.id ? "bg-[#4262ff] text-white" : "text-zinc-700 hover:bg-zinc-100"
            }`}
          >
            <Icon name={item.icon} />
          </button>
        ))}
      </div>
      {tool === "shape" ? (
        <div className="pointer-events-auto absolute left-[68px] top-1/2 z-20 -translate-y-1/2 rounded-xl border border-black/8 bg-white p-2 shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
          {(["rect", "round", "ellipse", "diamond"] as ShapeKind[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onShape(item)}
              className={`mb-1 block w-full rounded-md px-3 py-1.5 text-left text-xs capitalize last:mb-0 ${
                shape === item ? "bg-[#4262ff] text-white" : "hover:bg-zinc-100"
              }`}
            >
              {item === "round" ? "rounded" : item}
            </button>
          ))}
        </div>
      ) : null}
      {tool === "draw" ? (
        <div className="pointer-events-auto absolute left-[68px] top-1/2 z-20 -translate-y-1/2 rounded-xl border border-black/8 bg-white p-2 shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
          {([
            ["pen", "Pen"],
            ["highlight", "Highlighter"],
            ["erase", "Eraser"],
          ] as [DrawMode, string][]).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => onDrawMode(id)}
              className={`mb-1 block w-full rounded-md px-3 py-1.5 text-left text-xs last:mb-0 ${
                drawMode === id ? "bg-[#4262ff] text-white" : "hover:bg-zinc-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {(tool === "sticky" || tool === "shape" || (tool === "draw" && drawMode !== "erase")) && (
        <div className="pointer-events-auto absolute bottom-16 left-1/2 z-20 flex -translate-x-1/2 gap-1 rounded-full border border-black/8 bg-white p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
          {["#fde68a", "#fecaca", "#bfdbfe", "#bbf7d0", "#e9d5ff", "#fed7aa", "#ffffff", "#1f2937"].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onColor(value)}
              className={`h-6 w-6 rounded-full border ${color === value ? "ring-2 ring-[#4262ff] ring-offset-1" : "border-zinc-300"}`}
              style={{ background: value }}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function ZoomBar({
  zoom,
  showMap,
  onZoomIn,
  onZoomOut,
  onHundred,
  onFit,
  onToggleMap,
}: {
  zoom: number;
  showMap: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onHundred: () => void;
  onFit: () => void;
  onToggleMap: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute bottom-4 left-3 z-20 flex items-center gap-0.5 rounded-lg border border-black/8 bg-white p-0.5 shadow-[0_2px_12px_rgba(0,0,0,0.12)]">
      <button type="button" title="Zoom out" onClick={onZoomOut} className="h-8 w-8 rounded-md text-lg text-zinc-700 hover:bg-zinc-100">
        -
      </button>
      <button type="button" title="Zoom to 100% (Ctrl+0)" onClick={onHundred} className="min-w-14 rounded-md px-1 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100">
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" title="Zoom in" onClick={onZoomIn} className="h-8 w-8 rounded-md text-lg text-zinc-700 hover:bg-zinc-100">
        +
      </button>
      <button type="button" title="Fit to screen (Ctrl+1)" onClick={onFit} className="rounded-md px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100">
        Fit
      </button>
      <button type="button" title="Map" onClick={onToggleMap} className={`rounded-md px-2 py-1 text-xs ${showMap ? "bg-[#4262ff] text-white" : "text-zinc-700 hover:bg-zinc-100"}`}>
        Map
      </button>
    </div>
  );
}
