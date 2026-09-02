"use client";

import { useCallback, useEffect, useState } from "react";
import { ReactFlowProvider, type Edge, type Node } from "@xyflow/react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { readCache, writeCache } from "@/lib/cache";
import StrategyBoard from "@/components/canvas/StrategyBoard";
import { applyCanvasDraft } from "@/components/canvas/draft";
import ProjectChat from "@/components/ProjectChat";
import ProjectLibraryPanel from "@/components/ProjectLibraryPanel";
import { getPreference, loadPreferences, savePreference } from "@/lib/preferences";
import { loadWorkspaces, projectQuery } from "@/lib/workspace";
import type { CanvasSummary, ProjectDetail, UploadRecord } from "@/lib/types";

export default function ProjectPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** True only when the live API request failed and we fell back to cache. */
  const [offline, setOffline] = useState(false);
  /** True when a dirty browser draft is being / needs to be synced to the API. */
  const [draftPending, setDraftPending] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [uploading, setUploading] = useState(false);

  const loadProject = useCallback(
    async (canvasId?: string | null) => {
      const cacheKey = `project:${projectId}:${canvasId || "active"}`;
      try {
        const query = canvasId ? `?canvas_id=${encodeURIComponent(canvasId)}` : "";
        const project = await api<ProjectDetail>(`/api/projects/${projectId}${query}`);
        writeCache(`project:${projectId}:${project.canvas_id}`, project);
        writeCache(`project:${projectId}:active`, project);
        const next = applyCanvasDraft(project);
        setDetail(next.project);
        setActiveCanvasId(next.project.canvas_id);
        setOffline(false);
        setDraftPending(next.fromDraft);
        setError(null);
        return next.project;
      } catch (err) {
        const stored =
          readCache<ProjectDetail>(cacheKey) ||
          readCache<ProjectDetail>(`project:${projectId}:active`);
        if (stored) {
          const next = applyCanvasDraft(stored);
          setDetail(next.project);
          setActiveCanvasId(next.project.canvas_id);
          setOffline(true);
          setDraftPending(next.fromDraft);
          setError(null);
          return next.project;
        }
        throw err;
      }
    },
    [projectId],
  );

  useEffect(() => {
    void loadPreferences().then(() => {
      const collapsed = getPreference<boolean>("library_collapsed", false) === true;
      setLibraryOpen(!collapsed);
    });
  }, []);

  useEffect(() => {
    if (detail?.uploads?.length) {
      setLibraryOpen(true);
    }
  }, [detail?.uploads?.length]);

  useEffect(() => {
    void loadWorkspaces().catch(() => undefined);
  }, []);

  useEffect(() => {
    void loadProject().catch((err) => setError(err instanceof Error ? err.message : "Failed to load project"));
  }, [loadProject]);

  async function switchCanvas(canvasId: string) {
    if (canvasId === activeCanvasId) return;
    try {
      await loadProject(canvasId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch canvas");
    }
  }

  async function createCanvas() {
    const name = window.prompt("Canvas name?", "New canvas");
    if (!name?.trim()) return;
    try {
      const created = await api<CanvasSummary>(`/api/projects/${projectId}/canvases`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      await loadProject(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create canvas");
    }
  }

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      await api<UploadRecord>(`/api/uploads/file?${projectQuery(projectId)}`, {
        method: "POST",
        body: form,
      });
      await loadProject(activeCanvasId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const handleDraftSynced = useCallback(() => {
    setDraftPending(false);
    setOffline(false);
  }, []);

  if (error && !detail) {
    return <div className="p-6 text-sm text-red-600">{error}</div>;
  }
  if (!detail || !activeCanvasId) {
    return <div className="p-6 text-sm text-zinc-500">Loading project...</div>;
  }

  const initialNodes = (detail.canvas.nodes || []) as Node[];
  const initialEdges = (detail.canvas.edges || []) as Edge[];
  const initialFrames = (detail.canvas.frames || []) as Node[];
  const initialViewport = detail.canvas.viewport || null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2">
        <span className="mr-2 text-sm font-semibold text-zinc-800">{detail.project.name}</span>
        {detail.canvases.map((canvas) => (
          <button
            key={canvas.id}
            type="button"
            onClick={() => void switchCanvas(canvas.id)}
            className={`rounded-md px-3 py-1 text-xs ${
              canvas.id === activeCanvasId
                ? "bg-emerald-700 text-white"
                : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
            }`}
          >
            {canvas.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void createCanvas()}
          className="rounded-md border border-dashed border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:border-emerald-500 hover:text-emerald-700"
        >
          + New canvas
        </button>
      </div>

      {offline ? (
        <p className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
          Showing last saved work on this device. The server was unavailable — your canvas draft is kept locally and will
          sync when the API is back.
        </p>
      ) : draftPending ? (
        <p className="border-b border-sky-200 bg-sky-50 px-3 py-1.5 text-xs text-sky-900">
          Syncing unsaved local canvas changes to the server…
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <ProjectLibraryPanel
          projectId={projectId}
          uploads={detail.uploads}
          onUpload={uploadFile}
          uploading={uploading}
          collapsed={!libraryOpen}
          onToggleCollapsed={() => {
            setLibraryOpen((current) => {
              const next = !current;
              void savePreference("library_collapsed", !next);
              return next;
            });
          }}
        />

        <div className="relative h-full min-h-0 min-w-0 flex-1">
          <ReactFlowProvider>
            <StrategyBoard
              key={`${projectId}-${activeCanvasId}`}
              projectId={projectId}
              canvasId={activeCanvasId}
              initialNodes={initialNodes}
              initialEdges={initialEdges}
              initialFrames={initialFrames}
              initialViewport={initialViewport}
              initialUpdatedAt={detail.canvas.updated_at || null}
              onDraftSynced={handleDraftSynced}
            />
          </ReactFlowProvider>
        </div>

        <ProjectChat projectId={projectId} />
      </div>
    </div>
  );
}
