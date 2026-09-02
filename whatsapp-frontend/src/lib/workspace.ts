import { api } from "@/lib/api";
import { readCache, writeCache } from "@/lib/cache";
import { getPreference, loadPreferences, savePreference } from "@/lib/preferences";
import type { WorkspaceRecord } from "@/lib/types";

export const WORKSPACE_EVENT = "wa-active-workspace";

let cache: WorkspaceRecord[] | null = null;
let activeId: string | null = null;

function rememberActive(list: WorkspaceRecord[]) {
  if (!activeId || !list.some((item) => item.id === activeId)) {
    const preferred = getPreference<string | null>("active_workspace_id", null);
    activeId = preferred && list.some((item) => item.id === preferred) ? preferred : list[0]?.id || null;
  }
}

export async function loadWorkspaces(): Promise<WorkspaceRecord[]> {
  await loadPreferences();
  try {
    const list = await api<WorkspaceRecord[]>("/api/workspaces");
    cache = list;
    writeCache("workspaces", list);
    rememberActive(list);
    return list;
  } catch (err) {
    const stored = readCache<WorkspaceRecord[]>("workspaces") || [];
    if (stored.length) {
      cache = stored;
      rememberActive(stored);
      return stored;
    }
    throw err;
  }
}

export function workspaceQuery(extra?: Record<string, string>): string {
  const id = getActiveWorkspaceId();
  if (!id) throw new Error("No active workspace");
  const params = new URLSearchParams({ workspace_id: id });
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value) params.set(key, value);
    }
  }
  return params.toString();
}

export function getWorkspaces(): WorkspaceRecord[] {
  return cache || [];
}

export function getActiveWorkspaceId(): string | null {
  return activeId;
}

export function getActiveWorkspace(): WorkspaceRecord | null {
  if (!cache || !activeId) return null;
  return cache.find((item) => item.id === activeId) || null;
}

export async function setActiveWorkspaceId(id: string) {
  activeId = id;
  await savePreference("active_workspace_id", id);
  window.dispatchEvent(new CustomEvent(WORKSPACE_EVENT, { detail: { workspaceId: id } }));
}

export function projectQuery(projectId: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams({ project_id: projectId });
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value) params.set(key, value);
    }
  }
  return params.toString();
}

export async function refreshWorkspaces(): Promise<WorkspaceRecord[]> {
  return loadWorkspaces();
}

export async function createWorkspace(name: string): Promise<WorkspaceRecord> {
  const created = await api<WorkspaceRecord>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: name.trim() }),
  });
  await refreshWorkspaces();
  await setActiveWorkspaceId(created.id);
  return created;
}
