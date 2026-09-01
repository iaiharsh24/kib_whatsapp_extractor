"use client";

import { useEffect, useState } from "react";
import { api, getUser } from "@/lib/api";
import {
  getActiveWorkspace,
  getActiveWorkspaceId,
  loadWorkspaces,
  refreshWorkspaces,
  setActiveWorkspaceId,
} from "@/lib/workspace";
import type { InviteRecord, WorkspaceMemberRecord, WorkspaceRecord } from "@/lib/types";

export default function WorkspaceSettingsPage() {
  const [workspace, setWorkspace] = useState<WorkspaceRecord | null>(null);
  const [members, setMembers] = useState<WorkspaceMemberRecord[]>([]);
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workspaceId = getActiveWorkspaceId();
  const me = getUser();
  const isOwner = workspace?.role === "owner" || workspace?.owner_id === me?.id;

  async function load() {
    if (!workspaceId) return;
    await loadWorkspaces();
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
    if (!window.confirm("Leave this workspace?")) return;
    await api(`/api/workspaces/${workspaceId}/members/${me.id}`, { method: "DELETE" });
    const list = await refreshWorkspaces();
    if (list[0]) await setActiveWorkspaceId(list[0].id);
    window.location.href = "/";
  }

  async function deleteWorkspace() {
    if (!workspaceId) return;
    if (!window.confirm("Delete this workspace and all of its data? This cannot be undone.")) return;
    await api(`/api/workspaces/${workspaceId}`, { method: "DELETE" });
    const list = await refreshWorkspaces();
    if (list[0]) await setActiveWorkspaceId(list[0].id);
    window.location.href = "/";
  }

  async function createWorkspace() {
    const nextName = window.prompt("Workspace name?", "My workspace");
    if (!nextName?.trim()) return;
    const created = await api<WorkspaceRecord>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: nextName.trim() }),
    });
    await refreshWorkspaces();
    await setActiveWorkspaceId(created.id);
    window.location.reload();
  }

  if (!workspace) {
    return <div className="p-6 text-sm text-zinc-500">Loading workspace...</div>;
  }

  return (
    <div className="h-full overflow-auto p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Workspace settings</h2>
          <p className="mt-1 text-sm text-zinc-600">Manage members, invites, and workspace details.</p>
        </div>
        <button type="button" onClick={() => void createWorkspace()} className="rounded-md border border-zinc-300 px-3 py-2 text-sm">
          Create workspace
        </button>
      </div>
      {notice ? <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}
      {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-semibold">Details</h3>
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
        <table className="mt-4 w-full text-left text-sm">
          <thead className="text-xs uppercase text-zinc-500">
            <tr>
              <th className="py-2">User</th>
              <th>Email</th>
              <th>Role</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.user_id} className="border-t border-zinc-100">
                <td className="py-2">{member.username}</td>
                <td>{member.email || "-"}</td>
                <td className="capitalize">{member.role}</td>
                <td className="text-right">
                  {member.user_id === me?.id && member.role !== "owner" ? (
                    <button type="button" onClick={() => void leaveWorkspace()} className="text-zinc-600">
                      Leave
                    </button>
                  ) : null}
                  {isOwner && member.user_id !== workspace.owner_id && member.user_id !== me?.id ? (
                    <button type="button" onClick={() => void removeMember(member.user_id)} className="text-red-600">
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

      {isOwner ? (
        <section className="mt-8 rounded-xl border border-red-200 bg-red-50 p-5">
          <h3 className="font-semibold text-red-900">Danger zone</h3>
          <button type="button" onClick={() => void deleteWorkspace()} className="mt-3 rounded-md bg-red-700 px-3 py-2 text-sm text-white">
            Delete workspace
          </button>
        </section>
      ) : null}
    </div>
  );
}
