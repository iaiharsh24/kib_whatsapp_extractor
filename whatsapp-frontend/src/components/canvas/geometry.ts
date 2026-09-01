import type { Edge, Node } from "@xyflow/react";

export type Box = { x: number; y: number; w: number; h: number };
export type Guides = { x: number | null; y: number | null };

export function nodeMap(nodes: Node[]) {
  return new Map(nodes.map((node) => [node.id, node]));
}

export function nodeSize(node: Node) {
  return {
    w: Number(node.measured?.width || node.width || node.style?.width || 160),
    h: Number(node.measured?.height || node.height || node.style?.height || 100),
  };
}

export function absolutePosition(node: Node, byId: Map<string, Node>) {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

export function nodeBox(node: Node, byId: Map<string, Node>): Box {
  const origin = absolutePosition(node, byId);
  const size = nodeSize(node);
  return { x: origin.x, y: origin.y, w: size.w, h: size.h };
}

export function containsPoint(box: Box, point: { x: number; y: number }) {
  return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
}

export function isDescendant(nodeId: string, ancestorId: string, byId: Map<string, Node>) {
  let parentId = byId.get(nodeId)?.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    if (parentId === ancestorId) return true;
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
}

export function collectWithChildren(nodes: Node[], ids: Set<string>) {
  const include = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId && include.has(node.parentId) && !include.has(node.id)) {
        include.add(node.id);
        changed = true;
      }
    }
  }
  return include;
}

export function withParent(node: Node, parent: Node | undefined, byId: Map<string, Node>, keepGroupExtent: boolean): Node {
  const abs = absolutePosition(node, byId);
  if (!parent) {
    return {
      ...node,
      parentId: undefined,
      extent: undefined,
      expandParent: undefined,
      position: abs,
    };
  }
  const parentAbs = absolutePosition(parent, byId);
  return {
    ...node,
    parentId: parent.id,
    extent: keepGroupExtent && parent.type === "group" ? "parent" : undefined,
    expandParent: parent.type === "group" || parent.type === "frame",
    position: { x: abs.x - parentAbs.x, y: abs.y - parentAbs.y },
  };
}

export function frameAt(nodes: Node[], point: { x: number; y: number }, skipIds: Set<string>) {
  const byId = nodeMap(nodes);
  return nodes
    .filter((node) => node.type === "frame" && !skipIds.has(node.id))
    .map((node) => ({ node, box: nodeBox(node, byId) }))
    .filter((item) => containsPoint(item.box, point))
    .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0]?.node;
}

export function snapAndGuides(node: Node, next: { x: number; y: number }, nodes: Node[], threshold = 6): { position: { x: number; y: number }; guides: Guides } {
  const byId = nodeMap(nodes);
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  const parentAbs = parent ? absolutePosition(parent, byId) : { x: 0, y: 0 };
  const abs = { x: parentAbs.x + next.x, y: parentAbs.y + next.y };
  const size = nodeSize(node);
  const box = { x: abs.x, y: abs.y, w: size.w, h: size.h };
  const others = nodes.filter((item) => item.id !== node.id && !isDescendant(item.id, node.id, byId) && item.id !== node.parentId);
  let snapX = abs.x;
  let snapY = abs.y;
  let guideX: number | null = null;
  let guideY: number | null = null;
  for (const other of others) {
    const target = nodeBox(other, byId);
    const pairsX = [
      [box.x, target.x],
      [box.x + box.w / 2, target.x + target.w / 2],
      [box.x + box.w, target.x + target.w],
      [box.x, target.x + target.w],
      [box.x + box.w, target.x],
    ];
    const pairsY = [
      [box.y, target.y],
      [box.y + box.h / 2, target.y + target.h / 2],
      [box.y + box.h, target.y + target.h],
      [box.y, target.y + target.h],
      [box.y + box.h, target.y],
    ];
    for (const [from, to] of pairsX) {
      if (guideX === null && Math.abs(from - to) <= threshold) {
        snapX = abs.x + (to - from);
        guideX = to;
      }
    }
    for (const [from, to] of pairsY) {
      if (guideY === null && Math.abs(from - to) <= threshold) {
        snapY = abs.y + (to - from);
        guideY = to;
      }
    }
  }
  return {
    position: { x: snapX - parentAbs.x, y: snapY - parentAbs.y },
    guides: { x: guideX, y: guideY },
  };
}

export function distribute(nodes: Node[], dir: "h" | "v") {
  const picked = nodes.filter((node) => node.selected && !node.parentId);
  if (picked.length < 3) return nodes;
  const sized = picked
    .map((node) => ({ node, ...nodeSize(node) }))
    .sort((a, b) => (dir === "h" ? a.node.position.x - b.node.position.x : a.node.position.y - b.node.position.y));
  const first = sized[0];
  const last = sized[sized.length - 1];
  const span =
    dir === "h"
      ? last.node.position.x + last.w - first.node.position.x
      : last.node.position.y + last.h - first.node.position.y;
  const total = sized.reduce((sum, item) => sum + (dir === "h" ? item.w : item.h), 0);
  const gap = (span - total) / (sized.length - 1);
  let cursor = dir === "h" ? first.node.position.x : first.node.position.y;
  const nextPos = new Map<string, { x: number; y: number }>();
  sized.forEach((item, index) => {
    if (index === 0) {
      nextPos.set(item.node.id, item.node.position);
      cursor += (dir === "h" ? item.w : item.h) + gap;
      return;
    }
    if (index === sized.length - 1) {
      nextPos.set(item.node.id, item.node.position);
      return;
    }
    nextPos.set(
      item.node.id,
      dir === "h" ? { x: cursor, y: item.node.position.y } : { x: item.node.position.x, y: cursor },
    );
    cursor += (dir === "h" ? item.w : item.h) + gap;
  });
  return nodes.map((node) => (nextPos.has(node.id) ? { ...node, position: nextPos.get(node.id)! } : node));
}

export function groupSelected(nodes: Node[], uid: (prefix: string) => string) {
  const selected = nodes.filter((node) => node.selected && node.type !== "frame");
  if (selected.length < 2) return nodes;
  const byId = nodeMap(nodes);
  const boxes = selected.map((node) => nodeBox(node, byId));
  const pad = 28;
  const x = Math.min(...boxes.map((box) => box.x)) - pad;
  const y = Math.min(...boxes.map((box) => box.y)) - pad;
  const w = Math.max(...boxes.map((box) => box.x + box.w)) - x + pad;
  const h = Math.max(...boxes.map((box) => box.y + box.h)) - y + pad;
  const id = uid("group");
  const parentHint = selected[0]?.parentId && selected.every((node) => node.parentId === selected[0].parentId) ? selected[0].parentId : undefined;
  const parent = parentHint ? byId.get(parentHint) : undefined;
  const groupAbs = { x, y };
  const groupPos = parent ? { x: x - absolutePosition(parent, byId).x, y: y - absolutePosition(parent, byId).y } : groupAbs;
  const ids = new Set(selected.map((node) => node.id));
  const groupNode: Node = {
    id,
    type: "group",
    position: groupPos,
    parentId: parent?.id,
    style: { width: w, height: h },
    zIndex: -1,
    data: { label: "Group" },
    selected: true,
  };
  const nextById = new Map(byId);
  nextById.set(id, groupNode);
  const updated = nodes.map((node) => {
    if (!ids.has(node.id)) return { ...node, selected: false as const };
    return { ...withParent(node, groupNode, nextById, true), selected: false as const };
  });
  return [...updated, groupNode];
}

export function ungroupSelected(nodes: Node[]) {
  const groupIds = new Set(nodes.filter((node) => node.selected && node.type === "group").map((node) => node.id));
  if (groupIds.size === 0) {
    for (const node of nodes) {
      if (node.selected && node.parentId) {
        const parent = nodes.find((item) => item.id === node.parentId);
        if (parent?.type === "group") groupIds.add(parent.id);
      }
    }
  }
  if (groupIds.size === 0) return nodes;
  const byId = nodeMap(nodes);
  return nodes
    .filter((node) => !groupIds.has(node.id))
    .map((node) => {
      if (!node.parentId || !groupIds.has(node.parentId)) return node;
      const group = byId.get(node.parentId);
      const nextParent = group?.parentId ? byId.get(group.parentId) : undefined;
      return withParent(node, nextParent, byId, true);
    });
}

export function nodeSearchText(node: Node) {
  const data = (node.data || {}) as Record<string, unknown>;
  const tags = Array.isArray(data.tags) ? (data.tags as string[]).join(" ") : "";
  return [node.type, data.text, data.label, data.sender, data.previewTitle, data.url, tags]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function nodeTags(node: Node) {
  const tags = (node.data as { tags?: string[] } | undefined)?.tags;
  return Array.isArray(tags) ? tags.filter((item) => typeof item === "string" && item.trim()) : [];
}

export function connectedMediaNoteCluster(startId: string, nodes: Node[], edges: Edge[]) {
  const byId = nodeMap(nodes);
  const start = byId.get(startId);
  if (!start || (start.type !== "item" && start.type !== "note")) return [startId];
  const links: { a: string; b: string }[] = [];
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const noteItem =
      (source.type === "note" && target.type === "item") || (source.type === "item" && target.type === "note");
    if (!noteItem) continue;
    links.push({ a: edge.source, b: edge.target });
  }
  const adj = new Map<string, string[]>();
  for (const link of links) {
    adj.set(link.a, [...(adj.get(link.a) || []), link.b]);
    adj.set(link.b, [...(adj.get(link.b) || []), link.a]);
  }
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adj.get(current) || []) stack.push(next);
  }
  return [...seen];
}
