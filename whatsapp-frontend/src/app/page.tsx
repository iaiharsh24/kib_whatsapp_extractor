"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, formatWhen } from "@/lib/api";
import { WORKSPACE_EVENT, getActiveWorkspace, getActiveWorkspaceId, loadWorkspaces, workspaceQuery } from "@/lib/workspace";
import type { ProjectRecord } from "@/lib/types";

export default function ProjectsHomePage() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadProjects = useCallback(async () => {
    const workspaceId = getActiveWorkspaceId();
    if (!workspaceId) {
      setProjects([]);
      return;
    }
    setWorkspaceName(getActiveWorkspace()?.name || "Workspace");
    const rows = await api<ProjectRecord[]>(`/api/projects?${workspaceQuery()}`);
    setProjects(rows);
  }, []);

  useEffect(() => {
    void loadWorkspaces()
      .then(() => loadProjects())
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load projects"));
  }, [loadProjects]);

  useEffect(() => {
    function onWorkspaceChange() {
      void loadProjects().catch((err) => setError(err instanceof Error ? err.message : "Failed to load projects"));
    }
    window.addEventListener(WORKSPACE_EVENT, onWorkspaceChange);
    return () => window.removeEventListener(WORKSPACE_EVENT, onWorkspaceChange);
  }, [loadProjects]);

  async function createProject() {
    const workspaceId = getActiveWorkspaceId();
    if (!workspaceId) {
      setError("Select or create a workspace first.");
      return;
    }
    const name = window.prompt("Project name?", "New project");
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const created = await api<ProjectRecord>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), workspace_id: workspaceId }),
      });
      setProjects((current) => [created, ...current]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-auto p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Projects</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Each project is a folder in <span className="font-medium">{workspaceName || "your workspace"}</span>. Upload
            WhatsApp zips, browse that project&apos;s library, and build strategy canvases — all shared with workspace
            members.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void createProject()}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          New project
        </button>
      </div>

      {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}

      {projects.length === 0 ? (
        <div className="mt-12 rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center">
          <p className="text-sm text-zinc-600">No projects yet in this workspace.</p>
          <button
            type="button"
            onClick={() => void createProject()}
            className="mt-4 rounded-md bg-emerald-700 px-4 py-2 text-sm text-white"
          >
            Create your first project
          </button>
        </div>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-emerald-400 hover:shadow-md"
            >
              <h3 className="text-lg font-semibold">{project.name}</h3>
              <p className="mt-2 text-xs text-zinc-500">Created {formatWhen(project.created_at)}</p>
              <p className="mt-4 text-sm text-emerald-700">Open project →</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
