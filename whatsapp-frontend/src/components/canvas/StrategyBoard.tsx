"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  MarkerType,
  MiniMap,
  ReactFlow,
  SelectionMode,
  addEdge,
  applyNodeChanges as applyChanges,
  getNodesBounds,
  getViewportForBounds,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodePositionChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "@/lib/api";
import { markCanvasDraftSaved, readCanvasDraft, withRetry, writeCanvasDraft } from "@/lib/cache";
import type { CanvasHistoryEntry, MessageRecord, ProjectRecord } from "@/lib/types";
import { nodeTypes } from "./nodes";
import Toolbar, { ZoomBar } from "./Toolbar";
import SelectionBar from "./SelectionBar";
import { BoardChrome, HelperLines } from "./BoardChrome";
import { CanvasEditContext, type CanvasTool, type DrawMode, type ShapeKind } from "./CanvasContext";
import {
  absolutePosition,
  collectWithChildren,
  connectedMediaNoteCluster,
  containsPoint,
  defaultItemSize,
  distribute,
  frameAt,
  groupSelected,
  nodeBox,
  nodeMap,
  nodeSearchText,
  nodeSize,
  nodeTags,
  snapAndGuides,
  ungroupSelected,
  withParent,
  withResizeStyle,
  type Guides,
} from "./geometry";
import { buildTemplate } from "./templates";
import { TAGS_EVENT, saveMessageTags, uniqueTags, visibleTags } from "@/lib/tags";
import { getActiveWorkspaceId } from "@/lib/workspace";
import type { TagRecord } from "@/lib/types";

type BoardProps = {
  projectId: string;
  canvasId?: string;
  initialNodes: Node[];
  initialEdges: Edge[];
  initialFrames: Node[];
  initialViewport?: { x: number; y: number; zoom: number } | null;
};

type Snapshot = { nodes: Node[]; edges: Edge[] };

function canvasQuery(canvasId?: string): string {
  return canvasId ? `?canvas_id=${encodeURIComponent(canvasId)}` : "";
}

export default function StrategyBoard({
  projectId,
  canvasId,
  initialNodes,
  initialEdges,
  initialFrames,
  initialViewport,
}: BoardProps) {
  const { screenToFlowPosition, fitView, getNodes, getEdges, setViewport, zoomIn, zoomOut, zoomTo } = useReactFlow();
  const [nodes, setNodes, onNodesChangeBase] = useNodesState(
    [...(initialFrames || []), ...(initialNodes || [])].map(withResizeStyle),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges || []);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [drawMode, setDrawMode] = useState<DrawMode>("pen");
  const [shape, setShape] = useState<ShapeKind>("rect");
  const [color, setColor] = useState("#fde68a");
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [showMap, setShowMap] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId?: string } | null>(null);
  const [guides, setGuides] = useState<Guides>({ x: null, y: null });
  const [search, setSearch] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [tagFilter, setTagFilter] = useState("");
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [history, setHistory] = useState<CanvasHistoryEntry[]>([]);
  const saveTimer = useRef<number | null>(null);
  const skipFirstSave = useRef(true);
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const [undoCount, bump] = useState(0);
  const [spacePan, setSpacePan] = useState(false);
  const drawing = useRef<{ id: string; origin: { x: number; y: number }; points: { x: number; y: number }[] } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const viewportTimer = useRef<number | null>(null);

  const saveCanvas = useCallback(
    async (nextNodes: Node[], nextEdges: Edge[], viewport: { x: number; y: number; zoom: number }) => {
      const frames = nextNodes.filter((node) => node.type === "frame");
      const cards = nextNodes.filter((node) => node.type !== "frame");
      const payload = {
        nodes: cards.map(stripNode),
        edges: nextEdges.map(stripEdge),
        frames: frames.map(stripNode),
        viewport,
      };
      if (canvasId) {
        writeCanvasDraft({
          projectId,
          canvasId,
          nodes: payload.nodes,
          edges: payload.edges,
          frames: payload.frames,
          viewport,
          updatedAt: Date.now(),
          dirty: true,
        });
      }
      await withRetry(() =>
        api(`/api/projects/${projectId}/canvas${canvasQuery(canvasId)}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        }),
      );
      if (canvasId) markCanvasDraftSaved(projectId, canvasId);
      void api<CanvasHistoryEntry[]>(`/api/projects/${projectId}/canvas/history${canvasQuery(canvasId)}`)
        .then(setHistory)
        .catch(() => undefined);
    },
    [projectId, canvasId],
  );

  const saveViewport = useCallback(
    (viewport: { x: number; y: number; zoom: number }) => {
      if (viewportTimer.current) window.clearTimeout(viewportTimer.current);
      viewportTimer.current = window.setTimeout(() => {
        void saveCanvas(getNodes(), getEdges(), viewport).catch(() => undefined);
      }, 900);
    },
    [getEdges, getNodes, saveCanvas],
  );

  const persist = useCallback(
    (nextNodes: Node[], nextEdges: Edge[]) => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void saveCanvas(nextNodes, nextEdges, viewRef.current).catch(() => undefined);
      }, 700);
    },
    [saveCanvas],
  );

  useEffect(() => {
    if (skipFirstSave.current) {
      skipFirstSave.current = false;
      if (canvasId && readCanvasDraft(projectId, canvasId)?.dirty) {
        void saveCanvas(nodes, edges, viewRef.current).catch(() => undefined);
      }
      return;
    }
    persist(nodes, edges);
  }, [nodes, edges, persist, saveCanvas, canvasId, projectId]);

  useEffect(() => {
    function flushDraft() {
      if (!canvasId) return;
      const pending = Boolean(saveTimer.current || viewportTimer.current);
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (!pending) return;
      const allNodes = getNodes();
      const frames = allNodes.filter((node) => node.type === "frame");
      const cards = allNodes.filter((node) => node.type !== "frame");
      writeCanvasDraft({
        projectId,
        canvasId,
        nodes: cards.map(stripNode),
        edges: getEdges().map(stripEdge),
        frames: frames.map(stripNode),
        viewport: viewRef.current,
        updatedAt: Date.now(),
        dirty: true,
      });
    }
    window.addEventListener("pagehide", flushDraft);
    window.addEventListener("beforeunload", flushDraft);
    return () => {
      window.removeEventListener("pagehide", flushDraft);
      window.removeEventListener("beforeunload", flushDraft);
    };
  }, [canvasId, getEdges, getNodes, projectId]);

  useEffect(() => {
    const workspaceId = getActiveWorkspaceId();
    if (!workspaceId) return;
    void api<TagRecord[]>(`/api/workspaces/${workspaceId}/tags`)
      .then((rows) => setKnownTags(rows.map((row) => row.name)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    function onTags(event: Event) {
      const detail = (event as CustomEvent<{ messageId: string; tags: string[] }>).detail;
      if (!detail?.messageId) return;
      setKnownTags((current) => uniqueTags([...current, ...detail.tags]));
      setNodes((current) => {
        const hits = current.filter(
          (node) => node.type === "item" && (node.data as { messageId?: string }).messageId === detail.messageId,
        );
        if (hits.length === 0) return current;
        const cluster = new Set(hits.flatMap((node) => connectedMediaNoteCluster(node.id, current, getEdges())));
        return current.map((node) =>
          cluster.has(node.id) ? { ...node, data: { ...node.data, tags: detail.tags } } : node,
        );
      });
    }
    window.addEventListener(TAGS_EVENT, onTags);
    return () => window.removeEventListener(TAGS_EVENT, onTags);
  }, [getEdges, setNodes]);

  useEffect(() => {
    void api<CanvasHistoryEntry[]>(`/api/projects/${projectId}/canvas/history${canvasQuery(canvasId)}`)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [projectId, canvasId]);

  function snapshot() {
    past.current.push({
      nodes: structuredClone(getNodes().map(stripNode)),
      edges: structuredClone(getEdges().map(stripEdge)),
    });
    if (past.current.length > 60) past.current.shift();
    future.current = [];
    bump((value) => value + 1);
  }

  function undo() {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push({ nodes: getNodes().map(stripNode), edges: getEdges().map(stripEdge) });
    setNodes(prev.nodes);
    setEdges(prev.edges);
    bump((value) => value + 1);
  }

  function redo() {
    const next = future.current.pop();
    if (!next) return;
    past.current.push({ nodes: getNodes().map(stripNode), edges: getEdges().map(stripEdge) });
    setNodes(next.nodes);
    setEdges(next.edges);
    bump((value) => value + 1);
  }

  const patchNode = useCallback((id: string, data: Record<string, unknown>) => {
    setNodes((current) => current.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...data } } : node)));
  }, [setNodes]);

  const applyTagsToCluster = useCallback((cluster: string[], tags: string[], sourceNodes?: Node[]) => {
    const cleaned = uniqueTags(tags);
    const allNodes = sourceNodes || getNodes();
    setNodes((current) =>
      current.map((node) => (cluster.includes(node.id) ? { ...node, data: { ...node.data, tags: cleaned } } : node)),
    );
    const messageIds = [
      ...new Set(
        allNodes
          .filter((node) => cluster.includes(node.id) && node.type === "item")
          .map((node) => String((node.data as { messageId?: string }).messageId || ""))
          .filter(Boolean),
      ),
    ];
    for (const messageId of messageIds) void saveMessageTags(messageId, cleaned);
    setKnownTags((current) => uniqueTags([...current, ...cleaned]));
  }, [getNodes, setNodes]);

  const setNodeTags = useCallback(
    (id: string, tags: string[]) => {
      snapshot();
      const allNodes = getNodes();
      const cluster = connectedMediaNoteCluster(id, allNodes, getEdges());
      applyTagsToCluster(cluster, tags, allNodes);
    },
    [applyTagsToCluster, getEdges, getNodes],
  );

  const selected = nodes.filter((node) => node.selected);
  const selectedLocked = selected.length > 0 && selected.every((node) => !!(node.data as { locked?: boolean }).locked);
  const canGroup = selected.filter((node) => node.type !== "frame").length >= 2;
  const canUngroup = selected.some((node) => node.type === "group" || nodes.find((item) => item.id === node.parentId)?.type === "group");
  const taggableSelected = selected.filter((node) => node.type === "item" || node.type === "note");
  const selectedTags = uniqueTags(taggableSelected.flatMap((node) => nodeTags(node)));

  const onConnect = useCallback(
    (connection: Connection) => {
      snapshot();
      const nextEdges = addEdge(
        {
          ...connection,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          style: { stroke: "#2b2b2b", strokeWidth: 2 },
        },
        getEdges(),
      );
      setEdges(nextEdges);
      const allNodes = getNodes();
      const source = allNodes.find((node) => node.id === connection.source);
      const target = allNodes.find((node) => node.id === connection.target);
      const noteItem =
        (source?.type === "note" && target?.type === "item") || (source?.type === "item" && target?.type === "note");
      if (!noteItem || !connection.source) return;
      const cluster = connectedMediaNoteCluster(connection.source, allNodes, nextEdges);
      const merged = uniqueTags(
        cluster.flatMap((id) => {
          const node = allNodes.find((item) => item.id === id);
          return node ? nodeTags(node) : [];
        }),
      );
      applyTagsToCluster(cluster, merged, allNodes);
    },
    [getEdges, getNodes, setEdges, applyTagsToCluster],
  );

  function uid(prefix: string) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function addAt(type: string, position: { x: number; y: number }, extra: Partial<Node> = {}) {
    snapshot();
    let node: Node = {
      id: uid(type),
      type,
      position,
      style: extra.style,
      zIndex: extra.zIndex,
      data: extra.data || {},
    };
    if (type !== "frame" && type !== "group") {
      const hit = frameAt(getNodes(), position, new Set());
      if (hit) node = withParent(node, hit, nodeMap(getNodes()), true);
    }
    setNodes((current) => (type === "frame" || type === "group" ? [node, ...current] : current.concat(node)));
  }

  function placeFromTool(position: { x: number; y: number }) {
    if (tool === "sticky") addAt("note", position, { style: { width: 210, height: 150 }, data: { text: "", color, tags: [] } });
    else if (tool === "text") addAt("text", position, { style: { width: 220, height: 80 }, data: { text: "", color: "#18181b", fontSize: 20 } });
    else if (tool === "shape") addAt("shape", position, { style: { width: 180, height: 120 }, data: { text: "", color, shape } });
    else if (tool === "frame") addAt("frame", position, { style: { width: 460, height: 280, zIndex: -1 }, zIndex: -1, data: { label: "New frame", color: "#4262ff" } });
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    const raw = event.dataTransfer.getData("application/json");
    if (!raw) return;
    const message = JSON.parse(raw) as MessageRecord;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    snapshot();
    let node: Node = {
      id: uid("msg"),
      type: "item",
      position,
      style: defaultItemSize(message.type),
      data: {
        messageId: message.id,
        type: message.type,
        sender: message.sender,
        text: message.raw_text,
        url: message.extracted_url,
        previewImage: message.link_preview?.image || null,
        previewTitle: message.link_preview?.title || null,
        embed: message.link_preview?.embed || null,
        timestamp: message.timestamp || null,
        tags: uniqueTags(message.tags || []),
      },
    };
    const hit = frameAt(getNodes(), position, new Set());
    if (hit) node = withParent(node, hit, nodeMap(getNodes()), true);
    setNodes((current) => current.concat(node));
    void api(`/api/projects/${projectId}/items`, {
      method: "POST",
      body: JSON.stringify({ message_id: message.id }),
    });
  }

  function selectedIds() {
    return new Set(getNodes().filter((node) => node.selected).map((node) => node.id));
  }

  function duplicate() {
    const ids = selectedIds();
    if (ids.size === 0) return;
    snapshot();
    const all = getNodes();
    const include = collectWithChildren(all, ids);
    const remap = new Map<string, string>();
    include.forEach((id) => {
      const node = all.find((item) => item.id === id);
      remap.set(id, uid(node?.type || "node"));
    });
    const copies = all
      .filter((node) => include.has(node.id))
      .map((node) => ({
        ...structuredClone(stripNode(node)),
        id: remap.get(node.id) as string,
        parentId: node.parentId ? remap.get(node.parentId) || node.parentId : undefined,
        position: node.parentId ? node.position : { x: node.position.x + 28, y: node.position.y + 28 },
        selected: true,
      }));
    setNodes((current) => current.map((node) => ({ ...node, selected: false })).concat(copies));
  }

  function removeSelected() {
    const ids = selectedIds();
    if (ids.size === 0) return;
    snapshot();
    setNodes((current) => {
      const byId = nodeMap(current);
      const deleting = new Set(
        [...ids].filter((id) => !(byId.get(id)?.data as { locked?: boolean } | undefined)?.locked),
      );
      return current
        .map((node) => {
          if (!node.parentId || !deleting.has(node.parentId) || deleting.has(node.id)) return node;
          const parent = byId.get(node.parentId);
          const grand = parent?.parentId && !deleting.has(parent.parentId) ? byId.get(parent.parentId) : undefined;
          return withParent(node, grand, byId, true);
        })
        .filter((node) => !deleting.has(node.id));
    });
    setEdges((current) => current.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target) && !edge.selected));
  }

  function toggleLock() {
    const ids = selectedIds();
    snapshot();
    const next = !selectedLocked;
    setNodes((current) =>
      current.map((node) =>
        ids.has(node.id)
          ? { ...node, draggable: !next, deletable: !next, connectable: !next, data: { ...node.data, locked: next } }
          : node,
      ),
    );
  }

  function shiftZ(dir: "front" | "back") {
    const ids = selectedIds();
    snapshot();
    setNodes((current) => {
      const zs = current.map((node) => node.zIndex || 0);
      const extreme = dir === "front" ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1;
      return current.map((node) => (ids.has(node.id) ? { ...node, zIndex: extreme, style: { ...node.style, zIndex: extreme } } : node));
    });
  }

  function align(dir: "left" | "center" | "right" | "top" | "middle" | "bottom") {
    const picked = getNodes().filter((node) => node.selected && !node.parentId);
    if (picked.length < 2) return;
    snapshot();
    const xs = picked.map((node) => node.position.x);
    const ys = picked.map((node) => node.position.y);
    const ws = picked.map((node) => Number(node.measured?.width || node.width || node.style?.width || 160));
    const hs = picked.map((node) => Number(node.measured?.height || node.height || node.style?.height || 100));
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const right = Math.max(...picked.map((node, index) => node.position.x + ws[index]));
    const bottom = Math.max(...picked.map((node, index) => node.position.y + hs[index]));
    setNodes((current) =>
      current.map((node) => {
        if (!node.selected || node.parentId) return node;
        const w = Number(node.measured?.width || node.width || node.style?.width || 160);
        const h = Number(node.measured?.height || node.height || node.style?.height || 100);
        const position = { ...node.position };
        if (dir === "left") position.x = left;
        if (dir === "right") position.x = right - w;
        if (dir === "center") position.x = (left + right) / 2 - w / 2;
        if (dir === "top") position.y = top;
        if (dir === "bottom") position.y = bottom - h;
        if (dir === "middle") position.y = (top + bottom) / 2 - h / 2;
        return { ...node, position };
      }),
    );
  }

  function paint(nextColor: string) {
    const ids = selectedIds();
    snapshot();
    setNodes((current) => current.map((node) => (ids.has(node.id) ? { ...node, data: { ...node.data, color: nextColor } } : node)));
  }

  function fontSize(size: number) {
    const ids = selectedIds();
    snapshot();
    setNodes((current) => current.map((node) => (ids.has(node.id) ? { ...node, data: { ...node.data, fontSize: size } } : node)));
  }

  function setSelectedTags(tags: string[]) {
    if (taggableSelected.length === 0) return;
    snapshot();
    const allNodes = getNodes();
    const allEdges = getEdges();
    const cluster = new Set(
      taggableSelected.flatMap((node) => connectedMediaNoteCluster(node.id, allNodes, allEdges)),
    );
    applyTagsToCluster([...cluster], tags, allNodes);
  }

  function copy() {
    const ids = selectedIds();
    const all = getNodes();
    const include = collectWithChildren(all, ids);
    const payload = {
      nodes: all.filter((node) => include.has(node.id)).map(stripNode),
      edges: getEdges().filter((edge) => include.has(edge.source) && include.has(edge.target)).map(stripEdge),
    };
    window.localStorage.setItem("wa_canvas_clip", JSON.stringify(payload));
  }

  function paste() {
    const raw = window.localStorage.getItem("wa_canvas_clip");
    if (!raw) return;
    snapshot();
    const payload = JSON.parse(raw) as Snapshot;
    const remap = new Map<string, string>();
    for (const node of payload.nodes || []) {
      remap.set(node.id, uid(node.type || "node"));
    }
    const remapped = (payload.nodes || []).map((node) => ({
      ...node,
      id: remap.get(node.id) as string,
      parentId: node.parentId ? remap.get(node.parentId) : undefined,
      position: node.parentId ? node.position : { x: node.position.x + 36, y: node.position.y + 36 },
      selected: true,
    }));
    const edgeCopies = (payload.edges || []).map((edge) => ({
      ...edge,
      id: uid("e"),
      source: remap.get(edge.source) || edge.source,
      target: remap.get(edge.target) || edge.target,
    }));
    setNodes((current) => current.map((node) => ({ ...node, selected: false })).concat(remapped));
    setEdges((current) => current.concat(edgeCopies));
  }

  function settleParents(list: Node[]) {
    setNodes((current) => {
      let next = current;
      for (const node of list) {
        if (node.type === "frame" || node.type === "group") continue;
        const map = nodeMap(next);
        const live = map.get(node.id);
        if (!live) continue;
        const size = nodeSize(live);
        const abs = absolutePosition(live, map);
        const center = { x: abs.x + size.w / 2, y: abs.y + size.h / 2 };
        const currentParent = live.parentId ? map.get(live.parentId) : undefined;
        if (currentParent?.type === "group" && containsPoint(nodeBox(currentParent, map), center)) continue;
        const hit = frameAt(next, center, new Set([live.id]));
        const updated = withParent(live, hit, map, true);
        if (updated.parentId === live.parentId) continue;
        next = next.map((item) => (item.id === live.id ? updated : item));
      }
      return next;
    });
  }

  function onNodesChange(changes: NodeChange[]) {
    const dragging = changes.find((change): change is NodePositionChange => change.type === "position" && !!change.dragging && !!change.position);
    if (!dragging?.position) {
      setNodes((current) => {
        const next = applyChanges(changes, current);
        if (!changes.some((change) => change.type === "dimensions")) return next;
        return next.map((node) => {
          const touched = changes.some((change) => change.type === "dimensions" && change.id === node.id);
          if (!touched) return node;
          const w = node.width ?? node.measured?.width;
          const h = node.height ?? node.measured?.height;
          if (w == null && h == null) return node;
          return {
            ...node,
            style: {
              ...node.style,
              ...(w != null ? { width: w } : null),
              ...(h != null ? { height: h } : null),
            },
          };
        });
      });
      if (!changes.some((change) => change.type === "position" && "dragging" in change && change.dragging)) {
        setGuides({ x: null, y: null });
      }
      return;
    }
    const node = getNodes().find((item) => item.id === dragging.id);
    if (!node || !dragging.position) {
      onNodesChangeBase(changes);
      return;
    }
    const snapped = snapAndGuides(node, dragging.position, getNodes());
    setGuides(snapped.guides);
    onNodesChangeBase(
      changes.map((change) =>
        change.type === "position" && change.id === dragging.id && change.position
          ? { ...change, position: snapped.position }
          : change,
      ),
    );
  }

  function jumpSearch() {
    const query = search.trim().toLowerCase();
    if (!query) return;
    const matches = getNodes().filter((node) => nodeSearchText(node).includes(query));
    if (matches.length === 0) return;
    const node = matches[searchIndex % matches.length];
    setSearchIndex((value) => value + 1);
    void fitView({ nodes: [node], padding: 0.45, duration: 200 });
  }

  function applyTemplate(id: string) {
    const pane = document.querySelector(".miro-board");
    const rect = pane?.getBoundingClientRect();
    const origin = screenToFlowPosition({ x: (rect?.left || 80) + 80, y: (rect?.top || 80) + 80 });
    snapshot();
    const built = buildTemplate(id, origin, uid);
    setNodes((current) => current.concat(built.nodes));
    setEdges((current) => current.concat(built.edges));
    setTool("select");
  }

  function restoreHistory(index: number) {
    const item = history[index];
    if (!item?.id) return;
    void api<{ nodes: Node[]; edges: Edge[]; frames: Node[] }>(
      `/api/projects/${projectId}/canvas/history/${item.id}${canvasQuery(canvasId)}`,
    )
      .then((version) => {
        snapshot();
        setNodes([...(version.frames || []), ...(version.nodes || [])]);
        setEdges(version.edges || []);
      })
      .catch(() => undefined);
  }

  async function exportPng() {
    const { toPng } = await import("html-to-image");
    const visible = getNodes().filter((node) => !node.hidden);
    if (visible.length === 0) return;
    const bounds = getNodesBounds(visible);
    const width = Math.max(960, Math.round(bounds.width + 80));
    const height = Math.max(720, Math.round(bounds.height + 80));
    const viewport = getViewportForBounds(bounds, width, height, 0.5, 2, 0.08);
    const element = document.querySelector(".react-flow__viewport") as HTMLElement | null;
    if (!element) return;
    const dataUrl = await toPng(element, {
      backgroundColor: "#f5f5f5",
      width,
      height,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
      },
    });
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `strategy-board.png`;
    link.click();
  }

  async function duplicateBoard() {
    try {
      const created = await api<ProjectRecord>(`/api/projects/${projectId}/duplicate`, { method: "POST" });
      window.location.href = `/projects/${created.id}`;
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent("wa-shell-error", {
          detail: { message: err instanceof Error ? err.message : "Could not duplicate board" },
        }),
      );
    }
  }

  useEffect(() => {
    function typing(target: EventTarget | null) {
      return target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
    }
    function onKey(event: KeyboardEvent) {
      if (event.code === "Space") {
        if (!typing(event.target)) {
          setSpacePan(event.type === "keydown");
          if (event.type === "keydown") event.preventDefault();
        }
        return;
      }
      if (event.type !== "keydown") return;
      const key = event.key.toLowerCase();
      if (!typing(event.target) && !event.metaKey && !event.ctrlKey) {
        if (key === "v") setTool("select");
        if (key === "h") setTool("pan");
        if (key === "n") setTool("sticky");
        if (key === "t") setTool("text");
        if (key === "s") setTool("shape");
        if (key === "c") setTool("connect");
        if (key === "f") setTool("frame");
        if (key === "p") {
          setTool("draw");
          setDrawMode("pen");
        }
        if (key === "e") {
          setTool("draw");
          setDrawMode("erase");
        }
        if (key === "delete" || key === "backspace") {
          event.preventDefault();
          removeSelected();
        }
        if (key === "escape") {
          setTool("select");
          setMenu(null);
        }
        if (key === "=" || key === "+") {
          event.preventDefault();
          void zoomIn({ duration: 120 });
        }
        if (key === "-") {
          event.preventDefault();
          void zoomOut({ duration: 120 });
        }
      }
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      if (key === "f") {
        event.preventDefault();
        document.getElementById("board-search")?.focus();
      }
      if (key === "g") {
        event.preventDefault();
        snapshot();
        setNodes((current) => (event.shiftKey ? ungroupSelected(current) : groupSelected(current, uid)));
      }
      if (key === "0") {
        event.preventDefault();
        void zoomTo(1, { duration: 160 });
      }
      if (key === "1") {
        event.preventDefault();
        void fitView({ padding: 0.18, duration: 200 });
      }
      if (key === "2") {
        event.preventDefault();
        const picked = getNodes().filter((node) => node.selected);
        void fitView({ nodes: picked.length ? picked : undefined, padding: 0.2, duration: 200 });
      }
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
      if (key === "y") {
        event.preventDefault();
        redo();
      }
      if (key === "d") {
        event.preventDefault();
        duplicate();
      }
      if (key === "c" && !typing(event.target)) {
        event.preventDefault();
        copy();
      }
      if (key === "v" && !typing(event.target)) {
        event.preventDefault();
        paste();
      }
      if (key === "a" && !typing(event.target)) {
        event.preventDefault();
        setNodes((current) => current.map((node) => ({ ...node, selected: true })));
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  });

  function handlePaneClick(event: React.MouseEvent) {
    setMenu(null);
    if (event.detail === 2 && tool === "select" && !spacePan) {
      addAt("text", screenToFlowPosition({ x: event.clientX, y: event.clientY }), {
        style: { width: 220, height: 80 },
        data: { text: "", color: "#18181b", fontSize: 20 },
      });
      return;
    }
    if (tool === "select" || tool === "pan" || tool === "draw" || tool === "connect") return;
    placeFromTool(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }

  function onDrawStart(event: React.MouseEvent) {
    if (tool !== "draw" || drawMode === "erase") return;
    const target = event.target as HTMLElement;
    if (!target.classList.contains("react-flow__pane")) return;
    const origin = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    drawing.current = { id: uid("draw"), origin, points: [{ x: 0, y: 0 }] };
  }

  function onDrawMove(event: React.MouseEvent) {
    if (tool !== "draw" || drawMode === "erase" || !drawing.current) return;
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    drawing.current.points.push({ x: point.x - drawing.current.origin.x, y: point.y - drawing.current.origin.y });
  }

  function onDrawEnd() {
    const stroke = drawing.current;
    drawing.current = null;
    if (tool !== "draw" || drawMode === "erase" || !stroke || stroke.points.length < 2) return;
    const xs = stroke.points.map((point) => point.x);
    const ys = stroke.points.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const width = Math.max(40, Math.max(...xs) - minX + 8);
    const height = Math.max(40, Math.max(...ys) - minY + 8);
    const points = stroke.points.map((point) => ({ x: point.x - minX + 4, y: point.y - minY + 4 }));
    snapshot();
    setNodes((current) =>
      current.concat({
        id: stroke.id,
        type: "draw",
        position: { x: stroke.origin.x + minX, y: stroke.origin.y + minY },
        style: { width, height },
        data: { points, color, width, height, kind: drawMode === "highlight" ? "highlight" : "pen" },
        selectable: true,
      }),
    );
  }

  const edit = useMemo(
    () => ({ patchNode, setNodeTags, knownTags: uniqueTags([...knownTags, ...nodes.flatMap((node) => nodeTags(node))]) }),
    [knownTags, nodes, patchNode, setNodeTags],
  );
  const panMode = tool === "pan" || spacePan;
  const drawingNow = tool === "draw" && drawMode !== "erase";
  const boardTags = uniqueTags([...knownTags, ...nodes.flatMap((node) => nodeTags(node))]);

  const displayNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        hidden: Boolean(
          tagFilter &&
            (node.type === "item" || node.type === "note") &&
            !visibleTags(nodeTags(node)).some((tag) => tag.toLowerCase() === tagFilter.toLowerCase()),
        ),
      })),
    [nodes, tagFilter],
  );

  const frames = nodes
    .filter((node) => node.type === "frame")
    .map((node) => ({ id: node.id, label: String((node.data as { label?: string }).label || "Frame") }));

  useEffect(() => {
    if (!initialViewport || typeof initialViewport.zoom !== "number") return;
    setZoom(initialViewport.zoom);
    setView(initialViewport);
    void setViewport(initialViewport);
  }, [initialViewport, projectId, setViewport]);

  return (
    <CanvasEditContext.Provider value={edit}>
      <div className="relative flex h-full min-h-0 flex-col">
        <div
          className={`min-h-0 flex-1 ${
            panMode
              ? "cursor-grab active:cursor-grabbing"
              : drawingNow || tool === "draw"
                ? "cursor-crosshair"
                : tool === "select"
                  ? ""
                  : "cursor-crosshair"
          }`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
          onMouseDown={onDrawStart}
          onMouseMove={onDrawMove}
          onMouseUp={onDrawEnd}
        >
          <ReactFlow
            className="miro-board"
            nodes={displayNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onPaneClick={handlePaneClick}
            onNodeClick={(_event, node) => {
              if (tool === "draw" && drawMode === "erase" && node.type === "draw") {
                snapshot();
                setNodes((current) => current.filter((item) => item.id !== node.id));
              }
            }}
            onNodeDragStart={() => snapshot()}
            onSelectionDragStart={() => snapshot()}
            onNodeDragStop={(_event, node) => settleParents([node])}
            onSelectionDragStop={(_event, list) => settleParents(list)}
            onMove={(_event, viewport) => {
              setZoom(viewport.zoom);
              setView(viewport);
            }}
            onMoveEnd={(_event, viewport) => {
              setZoom(viewport.zoom);
              setView(viewport);
              saveViewport(viewport);
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY });
            }}
            selectionOnDrag={tool === "select" && !panMode}
            selectionMode={SelectionMode.Partial}
            panOnDrag={panMode ? true : [1, 2]}
            panOnScroll={false}
            zoomOnScroll
            zoomOnPinch
            zoomOnDoubleClick={false}
            minZoom={0.05}
            maxZoom={16}
            autoPanOnNodeDrag
            autoPanOnConnect
            preventScrolling
            selectNodesOnDrag={tool === "select"}
            nodesDraggable={!panMode && tool !== "draw"}
            nodesConnectable={tool === "connect" || tool === "select"}
            elementsSelectable={!panMode && (tool !== "draw" || drawMode === "erase")}
            connectionMode={ConnectionMode.Loose}
            connectionLineStyle={{ stroke: "#4262ff", strokeWidth: 2 }}
            snapToGrid={false}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            deleteKeyCode={null}
            multiSelectionKeyCode={["Shift", "Meta", "Control"]}
            onlyRenderVisibleElements
            elevateNodesOnSelect
            elevateEdgesOnSelect
            defaultEdgeOptions={{
              type: "smoothstep",
              markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
              style: { stroke: "#2b2b2b", strokeWidth: 2 },
            }}
            proOptions={{ hideAttribution: true }}
            style={{ width: "100%", height: "100%", background: "#f5f5f5" }}
          >
            <Background id="dots" variant={BackgroundVariant.Dots} gap={20} size={1} color="#e0e0e0" />
            {showMap ? (
              <MiniMap
                pannable
                zoomable
                position="bottom-right"
                className="canvas-tracker"
                style={{ bottom: 16, right: 16, width: 176, height: 112 }}
                bgColor="#1f1f1f"
                maskColor="rgba(139, 92, 246, 0.18)"
                maskStrokeColor="rgba(167, 139, 250, 0.85)"
                maskStrokeWidth={2}
                nodeColor={(node) => {
                  const type = String(node.type || "");
                  if (type === "frame") return "#f59e0b";
                  if (type === "sticky") return "#fde68a";
                  if (type === "media") return "#22d3ee";
                  if (type === "note") return "#86efac";
                  return "#60a5fa";
                }}
                nodeStrokeWidth={0}
              />
            ) : null}
          </ReactFlow>
          <HelperLines
            x={guides.x === null ? null : guides.x * view.zoom + view.x}
            y={guides.y === null ? null : guides.y * view.zoom + view.y}
          />
        </div>
        <Toolbar
          tool={tool}
          drawMode={drawMode}
          shape={shape}
          color={color}
          onTool={setTool}
          onDrawMode={setDrawMode}
          onShape={setShape}
          onColor={setColor}
          canUndo={undoCount >= 0 && past.current.length > 0}
          canRedo={undoCount >= 0 && future.current.length > 0}
          onUndo={undo}
          onRedo={redo}
        />
        <ZoomBar
          zoom={zoom}
          showMap={showMap}
          onZoomIn={() => void zoomIn({ duration: 120 })}
          onZoomOut={() => void zoomOut({ duration: 120 })}
          onHundred={() => void zoomTo(1, { duration: 160 })}
          onFit={() => void fitView({ padding: 0.18, duration: 200 })}
          onToggleMap={() => setShowMap((value) => !value)}
        />
        <BoardChrome
          search={search}
          onSearch={(value) => {
            setSearch(value);
            setSearchIndex(0);
          }}
          onJumpSearch={jumpSearch}
          tagFilter={tagFilter}
          onTagFilter={setTagFilter}
          tagOptions={boardTags}
          frames={frames}
          onJumpFrame={(id) => {
            const node = getNodes().find((item) => item.id === id);
            if (node) void fitView({ nodes: [node], padding: 0.25, duration: 200 });
          }}
          history={history}
          onRestore={restoreHistory}
          onTemplate={applyTemplate}
          onExport={() => void exportPng()}
          onDuplicate={() => void duplicateBoard()}
          canUndo={undoCount >= 0 && past.current.length > 0}
          canRedo={undoCount >= 0 && future.current.length > 0}
          onUndo={undo}
          onRedo={redo}
        />
        <SelectionBar
          count={selected.length}
          locked={selectedLocked}
          canGroup={canGroup}
          canUngroup={canUngroup}
          showTags={taggableSelected.length > 0}
          tags={selectedTags}
          knownTags={boardTags}
          onDuplicate={duplicate}
          onDelete={removeSelected}
          onLock={toggleLock}
          onFront={() => shiftZ("front")}
          onBack={() => shiftZ("back")}
          onAlign={align}
          onDistribute={(dir) => {
            snapshot();
            setNodes((current) => distribute(current, dir));
          }}
          onGroup={() => {
            snapshot();
            setNodes((current) => groupSelected(current, uid));
          }}
          onUngroup={() => {
            snapshot();
            setNodes((current) => ungroupSelected(current));
          }}
          onColor={paint}
          onFont={fontSize}
          onTags={setSelectedTags}
        />
        {menu ? (
          <div
            className="fixed z-50 min-w-40 rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            {menu.nodeId ? (
              <>
                <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-50" onClick={() => { duplicate(); setMenu(null); }}>
                  Duplicate
                </button>
                <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-50" onClick={() => { snapshot(); setNodes((current) => groupSelected(current, uid)); setMenu(null); }}>
                  Group
                </button>
                <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-50" onClick={() => { snapshot(); setNodes((current) => ungroupSelected(current)); setMenu(null); }}>
                  Ungroup
                </button>
                <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-50" onClick={() => { toggleLock(); setMenu(null); }}>
                  Lock / unlock
                </button>
                <button type="button" className="block w-full px-3 py-1.5 text-left text-red-700 hover:bg-red-50" onClick={() => { removeSelected(); setMenu(null); }}>
                  Delete
                </button>
              </>
            ) : (
              <>
                <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-50" onClick={() => { addAt("note", screenToFlowPosition({ x: menu.x, y: menu.y }), { style: { width: 210, height: 150 }, data: { text: "", color, tags: [] } }); setMenu(null); }}>
                  Sticky note
                </button>
                <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-50" onClick={() => { addAt("text", screenToFlowPosition({ x: menu.x, y: menu.y }), { style: { width: 220, height: 80 }, data: { text: "", fontSize: 20 } }); setMenu(null); }}>
                  Text
                </button>
                <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-50" onClick={() => { paste(); setMenu(null); }}>
                  Paste
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </CanvasEditContext.Provider>
  );
}

function stripNode(value: Node): Node {
  const w = value.width ?? value.measured?.width ?? value.style?.width;
  const h = value.height ?? value.measured?.height ?? value.style?.height;
  const next: Node = {
    ...value,
    style: {
      ...value.style,
      ...(w != null ? { width: w } : null),
      ...(h != null ? { height: h } : null),
    },
  };
  if (next.data && typeof next.data === "object") {
    const data = { ...(next.data as Record<string, unknown>) };
    delete data.onChange;
    next.data = data;
  }
  delete next.hidden;
  return next;
}

function stripEdge(value: Edge): Edge {
  if (value.data && typeof value.data === "object") {
    const data = { ...(value.data as Record<string, unknown>) };
    delete data.onChange;
    return { ...value, data };
  }
  return value;
}
