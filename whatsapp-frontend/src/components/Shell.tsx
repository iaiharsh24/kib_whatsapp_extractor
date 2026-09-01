"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, clearSession, getUser } from "@/lib/api";
import { getPreference, loadPreferences, savePreference } from "@/lib/preferences";
import {
  WORKSPACE_EVENT,
  createWorkspace,
  getActiveWorkspace,
  getActiveWorkspaceId,
  getWorkspaces,
  loadWorkspaces,
  refreshWorkspaces,
  setActiveWorkspaceId,
  workspaceQuery,
} from "@/lib/workspace";
import type { ProjectRecord, UserRecord, WorkspaceRecord } from "@/lib/types";

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<UserRecord | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceRecord | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const loadProjects = useCallback(async () => {
    const workspaceId = getActiveWorkspaceId();
    if (!workspaceId) {
      setProjects([]);
      return;
    }
    const rows = await api<ProjectRecord[]>(`/api/projects?${workspaceQuery()}`);
    setProjects(rows);
  }, []);

  useEffect(() => {
    void loadPreferences().then(() => setCollapsed(getPreference<boolean>("nav_collapsed", false) === true));
  }, []);

  useEffect(() => {
    setUser(getUser());
    void loadWorkspaces()
      .then((list) => {
        setWorkspaces(list);
        setActiveWorkspace(getActiveWorkspace());
        return loadProjects();
      })
      .catch(() => {
        setWorkspaces([]);
        setProjects([]);
      });
  }, [pathname, loadProjects]);

  useEffect(() => {
    function onWorkspaceChange() {
      setActiveWorkspace(getActiveWorkspace());
      void loadProjects();
    }
    window.addEventListener(WORKSPACE_EVENT, onWorkspaceChange);
    return () => window.removeEventListener(WORKSPACE_EVENT, onWorkspaceChange);
  }, [loadProjects]);

  function toggleNav() {
    setCollapsed((current) => {
      const next = !current;
      void savePreference("nav_collapsed", next);
      return next;
    });
  }

  function logout() {
    clearSession();
    router.replace("/login");
  }

  async function switchWorkspace(workspaceId: string) {
    await setActiveWorkspaceId(workspaceId);
    const list = await refreshWorkspaces();
    setWorkspaces(list);
    setActiveWorkspace(getActiveWorkspace());
    await loadProjects();
    if ((pathname ?? "").startsWith("/projects/")) router.push("/");
  }

  async function createWorkspacePrompt() {
    const name = window.prompt("Workspace name?", "My workspace");
    if (!name?.trim()) return;
    try {
      const created = await createWorkspace(name.trim());
      setWorkspaces(getWorkspaces());
      setActiveWorkspace(created);
      await loadProjects();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Could not create workspace");
    }
  }

  async function createProject() {
    const workspaceId = getActiveWorkspaceId();
    if (!workspaceId) {
      window.alert("Select or create a workspace first.");
      return;
    }
    const name = window.prompt("Project name?", "New strategy");
    if (!name?.trim()) return;
    try {
      const created = await api<ProjectRecord>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), workspace_id: workspaceId }),
      });
      setProjects((current) => [created, ...current]);
      router.push(`/projects/${created.id}`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Could not create project");
    }
  }

  function startRename(project: ProjectRecord) {
    setRenamingId(project.id);
    setDraftName(project.name);
  }

  async function saveRename(projectId: string) {
    const name = draftName.trim();
    setRenamingId(null);
    if (!name) return;
    try {
      const updated = await api<ProjectRecord>(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setProjects((current) => current.map((item) => (item.id === projectId ? updated : item)));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Could not rename project");
    }
  }

  async function duplicateProject(project: ProjectRecord) {
    try {
      const created = await api<ProjectRecord>(`/api/projects/${project.id}/duplicate`, { method: "POST" });
      setProjects((current) => [created, ...current]);
      router.push(`/projects/${created.id}`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Could not duplicate project");
    }
  }

  async function removeProject(project: ProjectRecord) {
    if (!window.confirm(`Delete "${project.name}"? This cannot be undone.`)) return;
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE" });
      setProjects((current) => current.filter((item) => item.id !== project.id));
      if (pathname === `/projects/${project.id}`) {
        const next = projects.find((item) => item.id !== project.id);
        router.push(next ? `/projects/${next.id}` : "/");
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Could not delete project");
    }
  }

  return (
    <div className="flex h-screen bg-[#f3efe6] text-zinc-900">
      <aside
        className={`flex shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-[#171717] text-zinc-100 transition-[width] duration-200 ${
          collapsed ? "w-12" : "w-56"
        }`}
      >
        <button
          type="button"
          onClick={toggleNav}
          title={collapsed ? "Expand menu" : "Collapse menu"}
          className={`border-b border-white/10 text-left hover:bg-white/5 ${collapsed ? "px-0 py-4" : "px-4 py-5"}`}
        >
          {collapsed ? (
            <span className="flex justify-center text-emerald-400">
              <Chevron dir="right" />
            </span>
          ) : (
            <span className="flex items-start justify-between gap-2">
              <span>
                <p className="text-[11px] uppercase tracking-[0.18em] text-emerald-400">Internal tool</p>
                <h1 className="mt-1 text-lg font-semibold leading-tight">Strategy Canvas</h1>
              </span>
              <Chevron dir="left" />
            </span>
          )}
        </button>

        {collapsed ? null : (
          <div className="border-b border-white/10 px-3 py-3">
            <label className="text-[10px] uppercase tracking-wide text-zinc-500">Workspace</label>
            <select
              value={activeWorkspace?.id || ""}
              onChange={(event) => void switchWorkspace(event.target.value)}
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-white"
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
            <div className="mt-2 flex gap-2 text-[11px]">
              <button type="button" onClick={() => void createWorkspacePrompt()} className="text-emerald-400 hover:underline">
                New
              </button>
              <Link href="/workspace" className="text-zinc-400 hover:text-white hover:underline">
                Settings
              </Link>
            </div>
          </div>
        )}

        <nav className={`flex flex-col gap-1 ${collapsed ? "p-1" : "p-3"}`}>
          <Link
            href="/"
            title="Library"
            className={`rounded-md text-sm ${
              collapsed ? "px-0 py-2 text-center" : "px-3 py-2"
            } ${pathname === "/" ? "bg-emerald-500/20 text-emerald-200" : "text-zinc-300 hover:bg-white/5"}`}
          >
            {collapsed ? "L" : "Library"}
          </Link>
          <Link
            href="/tags"
            title="Tags"
            className={`rounded-md text-sm ${
              collapsed ? "px-0 py-2 text-center" : "px-3 py-2"
            } ${(pathname ?? "").startsWith("/tags") ? "bg-emerald-500/20 text-emerald-200" : "text-zinc-300 hover:bg-white/5"}`}
          >
            {collapsed ? "T" : "Tags"}
          </Link>
          {user?.role === "admin" ? (
            <Link
              href="/admin"
              title="Admin"
              className={`rounded-md text-sm ${
                collapsed ? "px-0 py-2 text-center" : "px-3 py-2"
              } ${(pathname ?? "").startsWith("/admin") ? "bg-emerald-500/20 text-emerald-200" : "text-zinc-300 hover:bg-white/5"}`}
            >
              {collapsed ? "A" : "Admin"}
            </Link>
          ) : null}
        </nav>
        {collapsed ? null : (
          <>
            <div className="flex items-center justify-between px-3 pb-2">
              <span className="text-[11px] uppercase tracking-wide text-zinc-500">Projects</span>
              <button type="button" onClick={() => void createProject()} className="text-[11px] text-emerald-400 hover:underline">
                New
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-3">
              {projects.length === 0 ? (
                <p className="px-1 py-4 text-xs text-zinc-500">No projects yet. Click New to create one.</p>
              ) : (
                projects.map((project) => {
                  const active = pathname === `/projects/${project.id}`;
                  return (
                    <div
                      key={project.id}
                      className={`group mb-1 flex items-center rounded-md ${
                        active ? "bg-white/10 text-white" : "text-zinc-400 hover:bg-white/5 hover:text-white"
                      }`}
                    >
                      {renamingId === project.id ? (
                        <input
                          autoFocus
                          value={draftName}
                          onChange={(event) => setDraftName(event.target.value)}
                          onBlur={() => void saveRename(project.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              event.currentTarget.blur();
                            }
                            if (event.key === "Escape") setRenamingId(null);
                          }}
                          className="m-1 min-w-0 flex-1 rounded bg-black/40 px-2 py-1 text-sm text-white outline-none ring-1 ring-emerald-500"
                        />
                      ) : (
                        <>
                          <Link href={`/projects/${project.id}`} className="min-w-0 flex-1 truncate px-3 py-2 text-sm">
                            {project.name}
                          </Link>
                          <div className="mr-0.5 flex shrink-0 items-center">
                            <IconButton title="Rename" onClick={() => startRename(project)}>
                              <path d="M4 14.5 L13 5.5 l2.5 2.5 L6.5 17 H4 z M12 6.5 l2.5 2.5" />
                            </IconButton>
                            <IconButton title="Duplicate" onClick={() => void duplicateProject(project)}>
                              <rect x="7" y="7" width="9" height="9" rx="1" />
                              <rect x="4" y="4" width="9" height="9" rx="1" />
                            </IconButton>
                            <IconButton title="Delete" onClick={() => void removeProject(project)}>
                              <path d="M5 7 h10 M8 7 V5 h4 v2 M7 7 v8 h6 V7" />
                            </IconButton>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <div className="border-t border-white/10 p-3 text-xs text-zinc-400">
              <p className="truncate">{user?.email || user?.username}</p>
              <p className="capitalize">{user?.role}</p>
              <p className="mt-2 rounded bg-white/5 px-2 py-1 text-[10px] text-emerald-300">Local SQLite database</p>
              <button type="button" onClick={logout} className="mt-2 text-emerald-400 hover:underline">
                Sign out
              </button>
            </div>
          </>
        )}
        {collapsed ? (
          <div className="mt-auto border-t border-white/10 p-1">
            <button
              type="button"
              onClick={logout}
              title="Sign out"
              className="w-full rounded-md py-2 text-center text-xs text-emerald-400 hover:bg-white/5"
            >
              {user?.username?.slice(0, 1).toUpperCase() || "·"}
            </button>
          </div>
        ) : null}
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-white"
    >
      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
        {children}
      </svg>
    </button>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 opacity-70" fill="none" stroke="currentColor" strokeWidth="1.8">
      {dir === "left" ? <path d="M12.5 5 L7.5 10 L12.5 15" /> : <path d="M7.5 5 L12.5 10 L7.5 15" />}
    </svg>
  );
}
