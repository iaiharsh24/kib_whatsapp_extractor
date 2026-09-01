"use client";

import { useCallback, useEffect, useState } from "react";
import { ReactFlowProvider, type Edge, type Node } from "@xyflow/react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import StrategyBoard from "@/components/canvas/StrategyBoard";
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
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [uploading, setUploading] = useState(false);

  const loadProject = useCallback(
    async (canvasId?: string | null) => {
      const query = canvasId ? `?canvas_id=${encodeURIComponent(canvasId)}` : "";
      const project = await api<ProjectDetail>(`/api/projects/${projectId}${query}`);
      setDetail(project);
      setActiveCanvasId(project.canvas_id);
      setError(null);
      return project;
    },
    [projectId],
  );

  useEffect(() => {
    void loadPreferences().then(() => setLibraryOpen(getPreference<boolean>("library_collapsed", false) !== true));
  }, []);

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

  if (error) {
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
            />
          </ReactFlowProvider>
        </div>

        <ProjectChat projectId={projectId} />
      </div>
    </div>
  );
}
