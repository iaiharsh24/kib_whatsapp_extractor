"use client";

import { createContext, useContext } from "react";

export type CanvasTool =
  | "select"
  | "pan"
  | "sticky"
  | "text"
  | "shape"
  | "frame"
  | "draw"
  | "connect";

export type DrawMode = "pen" | "highlight" | "erase";
export type ShapeKind = "rect" | "ellipse" | "diamond" | "round";

export type CanvasPatch = (id: string, data: Record<string, unknown>) => void;

export const CanvasEditContext = createContext<{
  patchNode: CanvasPatch;
  setNodeTags: (id: string, tags: string[]) => void;
  knownTags: string[];
}>({
  patchNode: () => undefined,
  setNodeTags: () => undefined,
  knownTags: [],
});

export function useCanvasEdit() {
  return useContext(CanvasEditContext);
}

export const BOARD_COLORS = [
  "#fde68a",
  "#fecaca",
  "#bfdbfe",
  "#bbf7d0",
  "#e9d5ff",
  "#fed7aa",
  "#ffffff",
  "#1f2937",
];
