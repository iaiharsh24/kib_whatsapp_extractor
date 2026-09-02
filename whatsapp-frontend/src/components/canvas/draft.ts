import type { Edge, Node } from "@xyflow/react";
import { clearCanvasDraft, readCanvasDraft } from "@/lib/cache";
import type { MessageRecord, ProjectDetail } from "@/lib/types";

/** Refresh item-card fields from live messages while keeping draft layout. */
export function hydrateNodesFromItems(nodes: unknown[], items: MessageRecord[]): unknown[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return (nodes || []).map((node) => {
    if (!node || typeof node !== "object") return node;
    const cloned = { ...(node as Record<string, unknown>) };
    const data = { ...((cloned.data as Record<string, unknown>) || {}) };
    const messageId = String(data.messageId || "");
    const message = messageId ? byId.get(messageId) : undefined;
    if (!message) {
      cloned.data = data;
      return cloned;
    }
    const preview = message.link_preview || {};
    data.url = message.extracted_url;
    data.previewImage = preview.image ?? null;
    data.previewTitle = preview.title ?? null;
    data.embed = preview.embed ?? null;
    data.type = message.type || data.type;
    data.sender = message.sender || data.sender;
    data.text = message.raw_text || data.text;
    data.timestamp = message.timestamp || data.timestamp;
    data.tags = message.tags || data.tags || [];
    cloned.data = data;
    return cloned;
  });
}

function serverUpdatedMs(project: ProjectDetail): number {
  const raw = project.canvas?.updated_at;
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Apply a dirty local draft only when it is newer than the server canvas.
 * Always re-hydrate item metadata from project.items.
 */
export function applyCanvasDraft(project: ProjectDetail): { project: ProjectDetail; fromDraft: boolean } {
  const canvasId = project.canvas_id;
  const draft = canvasId ? readCanvasDraft(project.project.id, canvasId) : null;
  if (!draft?.dirty) {
    return {
      fromDraft: false,
      project: {
        ...project,
        canvas: {
          ...project.canvas,
          nodes: hydrateNodesFromItems(project.canvas.nodes || [], project.items || []),
        },
      },
    };
  }

  const serverMs = serverUpdatedMs(project);
  const draftMs = Number(draft.updatedAt) || 0;
  if (serverMs && draftMs && draftMs <= serverMs) {
    clearCanvasDraft(project.project.id, canvasId);
    return {
      fromDraft: false,
      project: {
        ...project,
        canvas: {
          ...project.canvas,
          nodes: hydrateNodesFromItems(project.canvas.nodes || [], project.items || []),
        },
      },
    };
  }

  return {
    fromDraft: true,
    project: {
      ...project,
      canvas: {
        ...project.canvas,
        nodes: hydrateNodesFromItems(draft.nodes || [], project.items || []),
        edges: draft.edges,
        frames: draft.frames,
        viewport: draft.viewport,
      },
    },
  };
}

export function canvasFingerprint(nodes: Node[], edges: Edge[]): string {
  return JSON.stringify({
    n: nodes.map((node) => [node.id, node.position, node.width, node.height, node.style, node.parentId, node.data]),
    e: edges.map((edge) => [edge.id, edge.source, edge.target, edge.sourceHandle, edge.targetHandle]),
  });
}
