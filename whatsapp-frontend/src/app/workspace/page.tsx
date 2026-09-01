"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getUser } from "@/lib/api";
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

export default function WorkspacePage() {
  const router = useRouter();
  const [allWorkspaces, setAllWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceRecord | null>(null);
  const [members, setMembers] = useState<WorkspaceMemberRecord[]>([]);
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [name, setName] = useState("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const workspaceId = getActiveWorkspaceId();
  const me = getUser();
  const isOwner = workspace?.role === "owner" || workspace?.owner_id === me?.id;

  async function load() {
    await loadWorkspaces();
    const list = getWorkspaces();
    setAllWorkspaces(list);
    const active = getActiveWorkspace();
    setWorkspace(active);
    setName(active?.name || "");
    if (!active) return;
    const [nextMembers, nextInvites] = await Promise.all([
      api<WorkspaceMemberRecord[]>(`/api/workspaces/${active.id}/members`).catch(() => []),
      api<InviteRecord[]>(`/api/workspaces/${active.id}/invites`).catch(() => []),
    ]);
    setMembers(nextMembers);
    setInvites(nextInvites.filter((item) => !item.revoked));
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load workspaces"));
  }, [workspaceId]);

  async function enterWorkspace(id: string) {
    await setActiveWorkspaceId(id);
    await refreshWorkspaces();
    router.push("/");
  }

  async function handleCreateWorkspace() {
    if (!newWorkspaceName.trim()) return;
    try {
      await createWorkspace(newWorkspaceName.trim());
      setNewWorkspaceName("");
      setNotice("Workspace created.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create workspace");
    }
  }

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

  return (
    <div className="h-full overflow-auto p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Workspaces</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Each workspace is its own universe — projects, uploads, and library stay inside it. Pick one to enter.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            value={newWorkspaceName}
            onChange={(event) => setNewWorkspaceName(event.target.value)}
            placeholder="New workspace name"
            className="min-w-56 rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void handleCreateWorkspace()}
            className="rounded-md bg-emerald-700 px-3 py-2 text-sm text-white"
          >
            Create
          </button>
        </div>
      </div>

      {notice ? <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}
      {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}

      <section className="mt-8">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {allWorkspaces.map((item) => {
            const active = item.id === workspaceId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => void enterWorkspace(item.id)}
                className={`group rounded-xl border p-5 text-left shadow-sm transition hover:shadow-md ${
                  active
                    ? "border-emerald-400 bg-emerald-50 ring-2 ring-emerald-300"
                    : "border-zinc-200 bg-white hover:border-emerald-300"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-lg font-semibold text-zinc-900">{item.name}</h3>
                  {active ? (
                    <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold uppercase text-white">
                      Active
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs capitalize text-zinc-500">{item.role || "member"}</p>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-zinc-50 px-2 py-2">
                    <p className="text-lg font-semibold text-zinc-900">{item.project_count ?? 0}</p>
                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">Projects</p>
                  </div>
                  <div className="rounded-lg bg-zinc-50 px-2 py-2">
                    <p className="text-lg font-semibold text-zinc-900">{item.upload_count ?? 0}</p>
                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">Zips</p>
                  </div>
                  <div className="rounded-lg bg-zinc-50 px-2 py-2">
                    <p className="text-lg font-semibold text-zinc-900">{item.message_count ?? 0}</p>
                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">Messages</p>
                  </div>
                </div>
                <p className="mt-4 text-sm font-medium text-emerald-700 group-hover:text-emerald-800">
                  {active ? "You are here" : "Enter workspace →"}
                </p>
              </button>
            );
          })}
        </div>
      </section>

      {workspace ? (
        <section className="mt-10 rounded-xl border border-zinc-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold">Manage: {workspace.name}</h3>
            <button
              type="button"
              onClick={() => setShowSettings((current) => !current)}
              className="text-sm text-emerald-700 hover:underline"
            >
              {showSettings ? "Hide settings" : "Show settings"}
            </button>
          </div>
          {showSettings ? (
            <div className="mt-4 space-y-6">
              <div>
                <p className="text-xs font-semibold uppercase text-zinc-500">Rename</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={!isOwner}
                    className="min-w-64 rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:bg-zinc-50"
                  />
                  {isOwner ? (
                    <button
                      type="button"
                      onClick={() => void saveName()}
                      className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white"
                    >
                      Save name
                    </button>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-zinc-500">Your role: {workspace.role || "member"}</p>
              </div>

              <div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase text-zinc-500">Members</p>
                  <button
                    type="button"
                    onClick={() => void createInvite()}
                    className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs text-white"
                  >
                    Invite link
                  </button>
                </div>
                <table className="mt-2 w-full text-left text-sm">
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
                            <button
                              type="button"
                              onClick={() => void removeMember(member.user_id)}
                              className="text-red-600"
                            >
                              Remove
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!isOwner ? (
                  <button
                    type="button"
                    onClick={() => void leaveWorkspace()}
                    className="mt-3 text-sm text-red-600"
                  >
                    Leave workspace
                  </button>
                ) : null}
              </div>

              <div>
                <p className="text-xs font-semibold uppercase text-zinc-500">Active invites</p>
                {invites.length === 0 ? (
                  <p className="mt-2 text-sm text-zinc-500">No active invite links.</p>
                ) : (
                  <table className="mt-2 w-full text-left text-sm">
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
                            <button
                              type="button"
                              onClick={() => void revokeInvite(invite.id)}
                              className="text-red-600"
                            >
                              Revoke
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
