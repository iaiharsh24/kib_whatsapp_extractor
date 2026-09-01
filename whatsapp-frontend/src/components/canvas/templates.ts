import type { Edge, Node } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";

export type BoardTemplate = {
  id: string;
  label: string;
  hint: string;
};

export const BOARD_TEMPLATES: BoardTemplate[] = [
  { id: "funnel", label: "Content funnel", hint: "Hook, proof, offer, CTA" },
  { id: "kanban", label: "Sort lanes", hint: "Three columns to group tagged items" },
  { id: "week", label: "Weekly grid", hint: "Mon-Sun content slots" },
  { id: "swipe", label: "Swipe file", hint: "Competitor / reference lanes" },
  { id: "swot", label: "SWOT", hint: "Four-quadrant notes" },
];

function edge(source: string, target: string): Edge {
  return {
    id: `e_${source}_${target}`,
    source,
    target,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    style: { stroke: "#2b2b2b", strokeWidth: 2 },
  };
}

export function buildTemplate(
  id: string,
  origin: { x: number; y: number },
  uid: (prefix: string) => string,
): { nodes: Node[]; edges: Edge[] } {
  if (id === "funnel") {
    const labels = ["Hook", "Proof", "Offer", "CTA"];
    const colors = ["#bfdbfe", "#bbf7d0", "#fde68a", "#fecaca"];
    const frames = labels.map((label, index) => {
      const frameId = uid("frame");
      return {
        frame: {
          id: frameId,
          type: "frame",
          position: { x: origin.x + index * 280, y: origin.y },
          style: { width: 250, height: 360, zIndex: -1 },
          zIndex: -1,
          data: { label, color: "#4262ff" },
        } as Node,
        note: {
          id: uid("note"),
          type: "note",
          parentId: frameId,
          position: { x: 20, y: 48 },
          style: { width: 210, height: 140 },
          expandParent: true,
          data: { text: "", color: colors[index], tags: [] },
        } as Node,
      };
    });
    return {
      nodes: frames.flatMap((item) => [item.frame, item.note]),
      edges: frames.slice(0, -1).map((item, index) => edge(item.note.id, frames[index + 1].note.id)),
    };
  }
  if (id === "kanban") {
    const lanes = [
      { label: "Inbox", color: "#e5e7eb" },
      { label: "Working", color: "#bbf7d0" },
      { label: "Done", color: "#bfdbfe" },
    ];
    return {
      nodes: lanes.map((lane, index) => ({
        id: uid("frame"),
        type: "frame",
        position: { x: origin.x + index * 300, y: origin.y },
        style: { width: 280, height: 520, zIndex: -1 },
        zIndex: -1,
        data: { label: lane.label, color: "#4262ff" },
      })),
      edges: [],
    };
  }
  if (id === "week") {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return {
      nodes: days.map((label, index) => ({
        id: uid("frame"),
        type: "frame",
        position: { x: origin.x + (index % 7) * 230, y: origin.y },
        style: { width: 210, height: 420, zIndex: -1 },
        zIndex: -1,
        data: { label, color: "#0f766e" },
      })),
      edges: [],
    };
  }
  if (id === "swipe") {
    const lanes = ["Competitor A", "Competitor B", "References"];
    return {
      nodes: lanes.map((label, index) => ({
        id: uid("frame"),
        type: "frame",
        position: { x: origin.x + index * 320, y: origin.y },
        style: { width: 300, height: 480, zIndex: -1 },
        zIndex: -1,
        data: { label, color: "#7c3aed" },
      })),
      edges: [],
    };
  }
  const quadrants = [
    { label: "Strengths", color: "#bbf7d0", x: 0, y: 40 },
    { label: "Weaknesses", color: "#fecaca", x: 280, y: 40 },
    { label: "Opportunities", color: "#bfdbfe", x: 0, y: 260 },
    { label: "Threats", color: "#fed7aa", x: 280, y: 260 },
  ];
  const title: Node = {
    id: uid("text"),
    type: "text",
    position: { x: origin.x, y: origin.y },
    style: { width: 280, height: 40 },
    data: { text: "SWOT", fontSize: 28, color: "#18181b" },
  };
  return {
    nodes: [
      title,
      ...quadrants.map((item) => ({
        id: uid("shape"),
        type: "shape",
        position: { x: origin.x + item.x, y: origin.y + item.y },
        style: { width: 250, height: 190 },
        data: { text: item.label, color: item.color, shape: "round" },
      })),
    ],
    edges: [],
  };
}
