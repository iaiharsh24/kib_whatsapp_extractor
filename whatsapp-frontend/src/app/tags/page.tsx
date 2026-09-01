"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { getActiveWorkspaceId, loadWorkspaces, WORKSPACE_EVENT } from "@/lib/workspace";
import type { TagRecord } from "@/lib/types";

export default function TagsPage() {
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [draft, setDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const workspaceId = getActiveWorkspaceId();

  async function load() {
    if (!workspaceId) return;
    const rows = await api<TagRecord[]>(`/api/workspaces/${workspaceId}/tags`);
    setTags(rows);
  }

  useEffect(() => {
    void loadWorkspaces()
      .then(() => load())
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load tags"));
  }, [workspaceId]);

  useEffect(() => {
    function onWorkspaceChange() {
      void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load tags"));
    }
    window.addEventListener(WORKSPACE_EVENT, onWorkspaceChange);
    return () => window.removeEventListener(WORKSPACE_EVENT, onWorkspaceChange);
  }, [workspaceId]);

  async function createTag() {
    if (!workspaceId || !draft.trim()) return;
    await api(`/api/workspaces/${workspaceId}/tags`, {
      method: "POST",
      body: JSON.stringify({ name: draft.trim() }),
    });
    setDraft("");
    await load();
  }

  async function saveRename(tagId: string) {
    if (!workspaceId || !renameValue.trim()) return;
    await api(`/api/workspaces/${workspaceId}/tags/${tagId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: renameValue.trim() }),
    });
    setRenamingId(null);
    await load();
  }

  async function removeTag(tagId: string, name: string) {
    if (!workspaceId) return;
    if (!window.confirm(`Delete tag "${name}" everywhere in this workspace?`)) return;
    await api(`/api/workspaces/${workspaceId}/tags/${tagId}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="h-full overflow-auto p-8">
      <h2 className="text-2xl font-semibold">Tags</h2>
      <p className="mt-1 text-sm text-zinc-600">
        Shared tag registry for the active workspace. Tags on library media are visible to all workspace members.
      </p>
      {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}

      <div className="mt-6 flex flex-wrap gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="New tag name"
          className="min-w-64 rounded-md border border-zinc-300 px-3 py-2 text-sm"
        />
        <button type="button" onClick={() => void createTag()} className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white">
          Add tag
        </button>
      </div>

      <table className="mt-6 w-full text-left text-sm">
        <thead className="text-xs uppercase text-zinc-500">
          <tr>
            <th className="py-2">Tag</th>
            <th>Uses</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {tags.map((tag) => (
            <tr key={tag.id} className="border-t border-zinc-100">
              <td className="py-2">
                {renamingId === tag.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={() => void saveRename(tag.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                    className="rounded border border-zinc-300 px-2 py-1"
                  />
                ) : (
                  tag.name
                )}
              </td>
              <td>{tag.count}</td>
              <td className="space-x-3 text-right">
                <button
                  type="button"
                  onClick={() => {
                    setRenamingId(tag.id);
                    setRenameValue(tag.name);
                  }}
                  className="text-emerald-700"
                >
                  Rename
                </button>
                <button type="button" onClick={() => void removeTag(tag.id, tag.name)} className="text-red-600">
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
