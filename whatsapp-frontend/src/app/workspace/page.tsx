"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { getUser } from "@/lib/api";
import {
  createWorkspace,
  getActiveWorkspace,
  getActiveWorkspaceId,
  getWorkspaces,
  loadWorkspaces,
  refreshWorkspaces,
  setActiveWorkspaceId,
} from "@/lib/workspace";
import type { InviteRecord, WorkspaceMemberRecord, WorkspaceRecord } from "@/lib/types";

export default function WorkspaceSettingsPage() {
  const [workspace, setWorkspace] = useState<WorkspaceRecord | null>(null);
  const [allWorkspaces, setAllWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [members, setMembers] = useState<WorkspaceMemberRecord[]>([]);
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [name, setName] = useState("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workspaceId = getActiveWorkspaceId();
  const me = getUser();
  const isOwner = workspace?.role === "owner" || workspace?.owner_id === me?.id;

  async function load() {
    if (!workspaceId) return;
    await loadWorkspaces();
    setAllWorkspaces(getWorkspaces());
    const active = getActiveWorkspace();
    setWorkspace(active);
    setName(active?.name || "");
    const [nextMembers, nextInvites] = await Promise.all([
      api<WorkspaceMemberRecord[]>(`/api/workspaces/${workspaceId}/members`),
      api<InviteRecord[]>(`/api/workspaces/${workspaceId}/invites`),
    ]);
    setMembers(nextMembers);
    setInvites(nextInvites.filter((item) => !item.revoked));
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load workspace"));
  }, [workspaceId]);

  async function saveName() {
    if (!workspaceId || !name.trim()) return;
    const updated = await api<WorkspaceRecord>(`/api/workspaces/${workspaceId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim() }),
    });
    await refreshWorkspaces();
    setWorkspace({ ...updated, role: workspace?.role || "owner" });
    setNotice("Workspace renamed.");
  }

  async function createInvite() {
    if (!workspaceId) return;
    const invite = await api<InviteRecord>(`/api/workspaces/${workspaceId}/invites`, {
      method: "POST",
      body: JSON.stringify({ role: "member" }),
    });
    const link = `${window.location.origin}${invite.link}`;
    await navigator.clipboard.writeText(link).catch(() => undefined);
    setNotice(`Invite link copied: ${link}`);
    await load();
  }

  async function revokeInvite(inviteId: string) {
    if (!workspaceId) return;
    await api(`/api/workspaces/${workspaceId}/invites/${inviteId}`, { method: "DELETE" });
    await load();
  }

  async function removeMember(userId: string) {
    if (!workspaceId) return;
    if (!window.confirm("Remove this member from the workspace?")) return;
    await api(`/api/workspaces/${workspaceId}/members/${userId}`, { method: "DELETE" });
    await load();
  }

  async function leaveWorkspace() {
    if (!workspaceId || !me) return;
    if (!window.confirm("Leave this workspace? You will lose access to its uploads and projects.")) return;
    await api(`/api/workspaces/${workspaceId}/members/${me.id}`, { method: "DELETE" });
    await refreshWorkspaces();
    const next = getWorkspaces()[0];
    if (next) await setActiveWorkspaceId(next.id);
    window.location.href = "/";
  }

  async function handleCreateWorkspace() {
    if (!newWorkspaceName.trim()) return;
    try {
      await createWorkspace(newWorkspaceName.trim());
      setNewWorkspaceName("");
      setNotice("Workspace created and selected.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create workspace");
    }
  }

  async function switchTo(id: string) {
    await setActiveWorkspaceId(id);
    await load();
    setNotice("Switched workspace.");
  }

  if (!workspace) {
    return <div className="p-6 text-sm text-zinc-500">Loading workspace...</div>;
  }

  return (
    <div className="h-full overflow-auto p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Workspaces</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Create separate workspaces for different teams or clients. Media tags are shared with everyone in the same
            workspace.
          </p>
        </div>
      </div>
      {notice ? <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}
      {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-semibold">Your workspaces</h3>
        <div className="mt-4 flex flex-wrap gap-2">
          <input
            value={newWorkspaceName}
            onChange={(event) => setNewWorkspaceName(event.target.value)}
            placeholder="New workspace name"
            className="min-w-64 rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void handleCreateWorkspace()}
            className="rounded-md bg-emerald-700 px-3 py-2 text-sm text-white"
          >
            Create workspace
          </button>
        </div>
        <ul className="mt-4 space-y-2">
          {allWorkspaces.map((item) => (
            <li
              key={item.id}
              className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                item.id === workspaceId ? "border-emerald-300 bg-emerald-50" : "border-zinc-200"
              }`}
            >
              <span>
                <span className="font-medium">{item.name}</span>
                <span className="ml-2 text-xs text-zinc-500 capitalize">{item.role || "member"}</span>
              </span>
              {item.id === workspaceId ? (
                <span className="text-xs text-emerald-700">Active</span>
              ) : (
                <button type="button" onClick={() => void switchTo(item.id)} className="text-emerald-700 hover:underline">
                  Switch
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-semibold">Active workspace details</h3>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={!isOwner}
            className="min-w-64 rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:bg-zinc-50"
          />
          {isOwner ? (
            <button type="button" onClick={() => void saveName()} className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white">
              Save name
            </button>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-zinc-500">Your role: {workspace.role || "member"}</p>
      </section>

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold">Members</h3>
          <button type="button" onClick={() => void createInvite()} className="rounded-md bg-emerald-700 px-3 py-2 text-sm text-white">
            Invite link
          </button>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Invite teammates to share uploads, library media, tags, and projects in this workspace.
        </p>
        <table className="mt-4 w-full text-left text-sm">
          <thead className="text-xs uppercase text-zinc-500">
            <tr>
              <th className="py-2">Member</th>
              <th>Role</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.user_id} className="border-t border-zinc-100">
                <td className="py-2">{member.email || member.username}</td>
                <td className="capitalize">{member.role}</td>
                <td className="text-right">
                  {isOwner && member.user_id !== me?.id ? (
                    <button type="button" onClick={() => void removeMember(member.user_id)} className="text-red-600">
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!isOwner ? (
          <button type="button" onClick={() => void leaveWorkspace()} className="mt-4 text-sm text-red-600">
            Leave workspace
          </button>
        ) : null}
      </section>

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-semibold">Active invites</h3>
        {invites.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No active invite links yet.</p>
        ) : (
          <table className="mt-4 w-full text-left text-sm">
            <thead className="text-xs uppercase text-zinc-500">
              <tr>
                <th className="py-2">Link</th>
                <th>Uses</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <tr key={invite.id} className="border-t border-zinc-100">
                  <td className="py-2 font-mono text-xs">{invite.link}</td>
                  <td>{invite.used_count}</td>
                  <td className="text-right">
                    <button type="button" onClick={() => void revokeInvite(invite.id)} className="text-red-600">
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
