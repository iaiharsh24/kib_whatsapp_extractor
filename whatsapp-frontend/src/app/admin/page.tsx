"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { describeActivity, roleBadge } from "@/lib/activity";
import { api, formatWhen, getUser } from "@/lib/api";
import { getActiveWorkspaceId, loadWorkspaces, workspaceQuery } from "@/lib/workspace";
import type { ActivityLogRecord, ActivityLogResponse, SignupCodeRecord, UploadRecord, UserRecord } from "@/lib/types";

export default function AdminPage() {
  const router = useRouter();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [signupCodes, setSignupCodes] = useState<SignupCodeRecord[]>([]);
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLogRecord[]>([]);
  const [activityTotal, setActivityTotal] = useState(0);
  const [allWorkspaces, setAllWorkspaces] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"superadmin" | "admin" | "member">("member");
  const [codeNote, setCodeNote] = useState("");
  const [codeUses, setCodeUses] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pwDraft, setPwDraft] = useState<Record<string, string>>({});
  const [pwBusy, setPwBusy] = useState<Record<string, boolean>>({});
  const me = getUser();
  const isSuper = !!me?.is_super_admin;

  async function load() {
    const workspaceId = getActiveWorkspaceId();
    const uploadPromise = workspaceId
      ? api<UploadRecord[]>(`/api/uploads?${workspaceQuery()}`)
      : Promise.resolve([] as UploadRecord[]);
    const logParams = new URLSearchParams({ limit: "150" });
    if (!allWorkspaces && workspaceId) logParams.set("workspace_id", workspaceId);
    const [nextUsers, nextCodes, nextUploads, nextLogs] = await Promise.all([
      api<UserRecord[]>("/api/admin/users"),
      api<SignupCodeRecord[]>("/api/admin/signup-codes"),
      uploadPromise,
      api<ActivityLogResponse>(`/api/admin/activity-logs?${logParams.toString()}`),
    ]);
    setUsers(nextUsers);
    setSignupCodes(nextCodes);
    setUploads(nextUploads);
    setActivityLogs(nextLogs.items);
    setActivityTotal(nextLogs.total);
  }

  useEffect(() => {
    const me = getUser();
    if (me && me.role !== "admin" && me.role !== "superadmin" && !me.is_super_admin) {
      router.replace("/");
      return;
    }
    void loadWorkspaces()
      .then(() => load())
      .catch((err) => setError(err instanceof Error ? err.message : "Admin load failed"));
  }, [router, allWorkspaces]);

  async function addMember() {
    if (!email.trim()) return;
    const created = await api<UserRecord>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        email: email.trim(),
        role,
        password: password.trim() || undefined,
      }),
    });
    setNotice(
      password.trim()
        ? `Created ${created.email || created.username} with your chosen password.`
        : `Created ${created.email || created.username}. Temporary password: ${created.temporary_password}`,
    );
    setEmail("");
    setPassword("");
    await load();
  }

  async function createSignupCode() {
    const created = await api<SignupCodeRecord>("/api/admin/signup-codes", {
      method: "POST",
      body: JSON.stringify({
        note: codeNote.trim() || undefined,
        max_uses: codeUses,
        workspace_id: getActiveWorkspaceId() || undefined,
      }),
    });
    const link = `${window.location.origin}${created.link}`;
    setNotice(`Signup code: ${created.code} · Share link: ${link}`);
    setCodeNote("");
    await load();
  }

  async function revokeSignupCode(codeId: string) {
    await api(`/api/admin/signup-codes/${codeId}`, { method: "DELETE" });
    await load();
  }

  function copySignupLink(link: string) {
    const full = `${window.location.origin}${link}`;
    void navigator.clipboard.writeText(full);
    setNotice(`Copied signup link: ${full}`);
  }

  async function resetPassword(userId: string) {
    const result = await api<{ temporary_password: string }>(`/api/admin/users/${userId}/reset-password`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    setNotice(`New auto-generated password: ${result.temporary_password}`);
    await load();
  }

  async function setPasswordFor(userId: string) {
    const next = (pwDraft[userId] || "").trim();
    if (!next) {
      setNotice("Enter a new password first.");
      return;
    }
    if (next.length < 8) {
      setNotice("Password must be at least 8 characters.");
      return;
    }
    setPwBusy((current) => ({ ...current, [userId]: true }));
    try {
      await api<{ temporary_password: string }>(`/api/admin/users/${userId}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ password: next }),
      });
      setNotice(`Password updated for the user.`);
      setPwDraft((current) => {
        const copy = { ...current };
        delete copy[userId];
        return copy;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set password");
    } finally {
      setPwBusy((current) => ({ ...current, [userId]: false }));
    }
  }

  async function changeRole(userId: string, next: "superadmin" | "admin" | "member") {
    await api(`/api/admin/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: next }),
    });
    await load();
  }

  async function removeUser(userId: string) {
    if (!window.confirm("Remove this teammate?")) return;
    await api(`/api/admin/users/${userId}`, { method: "DELETE" });
    await load();
  }

  async function deleteUpload(uploadId: string) {
    if (!window.confirm("Delete this upload and all of its messages?")) return;
    await api(`/api/uploads/${uploadId}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="h-full overflow-auto p-8">
      <h2 className="text-2xl font-semibold">Admin</h2>
      <p className="mt-1 text-sm text-zinc-600">Team accounts, uploads, and activity for the workspace.</p>
      {notice ? <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}
      {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">Activity log</h3>
            <p className="mt-1 text-sm text-zinc-600">
              Who did what — workspaces, projects, uploads, invites, and admin actions.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-600">
            <input
              type="checkbox"
              checked={allWorkspaces}
              onChange={(event) => setAllWorkspaces(event.target.checked)}
            />
            Show all workspaces
          </label>
        </div>
        {activityLogs.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">No activity recorded yet.</p>
        ) : (
          <div className="mt-4 max-h-[420px] overflow-auto rounded-lg border border-zinc-100">
            <ul className="divide-y divide-zinc-100">
              {activityLogs.map((log) => {
                const { who, what } = describeActivity(log);
                return (
                  <li key={log.id} className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-emerald-800">{who}</span>
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
                        {roleBadge(log.user_role)}
                      </span>
                      <span className="text-xs text-zinc-400">{formatWhen(log.created_at)}</span>
                    </div>
                    <p className="mt-1 font-medium tracking-wide text-zinc-800">{what}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {activityTotal > activityLogs.length ? (
          <p className="mt-2 text-xs text-zinc-500">
            Showing {activityLogs.length} of {activityTotal} events.
          </p>
        ) : null}
      </section>

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-semibold">Signup codes</h3>
        <p className="mt-1 text-sm text-zinc-600">
          Generate a personal code so someone can create their own login. Codes for the active workspace also add the
          new user to that workspace.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <input
            value={codeNote}
            onChange={(event) => setCodeNote(event.target.value)}
            placeholder="Label (e.g. Harsh's invite)"
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <input
            type="number"
            min={1}
            max={100}
            value={codeUses}
            onChange={(event) => setCodeUses(Number(event.target.value) || 1)}
            className="w-24 rounded-md border border-zinc-300 px-3 py-2 text-sm"
            title="Max uses"
          />
          <button
            type="button"
            onClick={() => void createSignupCode()}
            className="rounded-md bg-emerald-700 px-3 py-2 text-sm text-white"
          >
            Generate code
          </button>
        </div>
        {signupCodes.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No signup codes yet.</p>
        ) : (
          <table className="mt-4 w-full text-left text-sm">
            <thead className="text-xs uppercase text-zinc-500">
              <tr>
                <th className="py-2">Code</th>
                <th>Label</th>
                <th>Uses</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {signupCodes.map((item) => (
                <tr key={item.id} className="border-t border-zinc-100">
                  <td className="py-2 font-mono text-xs">{item.code}</td>
                  <td>{item.note || "—"}</td>
                  <td>
                    {item.used_count}/{item.max_uses}
                    {item.revoked ? " · revoked" : ""}
                  </td>
                  <td className="space-x-3 text-right">
                    {!item.revoked && item.used_count < item.max_uses ? (
                      <button type="button" onClick={() => copySignupLink(item.link)} className="text-emerald-700">
                        Copy link
                      </button>
                    ) : null}
                    {!item.revoked ? (
                      <button type="button" onClick={() => void revokeSignupCode(item.id)} className="text-red-600">
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-semibold">Team management</h3>
        <p className="mt-1 text-sm text-zinc-600">
          Create a login directly for someone on your team. Roles: <span className="font-medium">superadmin</span> (you) →{" "}
          <span className="font-medium">admin</span> → <span className="font-medium">member</span>.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="New email"
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password (optional — auto-generates if blank)"
            className="min-w-56 flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as "superadmin" | "admin" | "member")}
            className="rounded-md border border-zinc-300 px-2 py-2 text-sm"
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
            {isSuper ? <option value="superadmin">superadmin</option> : null}
          </select>
          <button type="button" onClick={() => void addMember()} className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white">
            Add member
          </button>
        </div>
        <table className="mt-4 w-full text-left text-sm">
          <thead className="text-xs uppercase text-zinc-500">
            <tr>
              <th className="py-2">User</th>
              <th>Role</th>
              <th>Set / reset password</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const canEditRole = isSuper || user.role !== "superadmin";
              return (
                <tr key={user.id} className="border-t border-zinc-100 align-top">
                  <td className="py-2">
                    <p className="font-medium">{user.email || user.username}</p>
                    {user.is_super_admin ? (
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">super admin</span>
                    ) : null}
                  </td>
                  <td className="py-2">
                    <select
                      value={user.role}
                      disabled={!canEditRole}
                      onChange={(event) => void changeRole(user.id, event.target.value as "superadmin" | "admin" | "member")}
                      className="rounded-md border border-zinc-300 px-2 py-1 text-xs disabled:opacity-60"
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                      <option value="superadmin" disabled={!isSuper}>superadmin</option>
                    </select>
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <input
                        type="password"
                        value={pwDraft[user.id] || ""}
                        onChange={(event) => setPwDraft((current) => ({ ...current, [user.id]: event.target.value }))}
                        placeholder="New password"
                        className="min-w-40 rounded-md border border-zinc-300 px-2 py-1 text-xs"
                      />
                      <button
                        type="button"
                        disabled={!!pwBusy[user.id]}
                        onClick={() => void setPasswordFor(user.id)}
                        className="rounded-md bg-zinc-900 px-2 py-1 text-xs text-white disabled:opacity-50"
                      >
                        {pwBusy[user.id] ? "Saving…" : "Set"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void resetPassword(user.id)}
                        className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
                        title="Generate a random password"
                      >
                        Auto-reset
                      </button>
                    </div>
                  </td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => void removeUser(user.id)}
                      disabled={user.is_super_admin}
                      className="text-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
                      title={user.is_super_admin ? "Super admins cannot be removed here" : "Remove user"}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-semibold">Upload management</h3>
        <table className="mt-4 w-full text-left text-sm">
          <thead className="text-xs uppercase text-zinc-500">
            <tr>
              <th className="py-2">File</th>
              <th>By</th>
              <th>Date</th>
              <th>Messages</th>
              <th>Skipped</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {uploads.map((upload) => (
              <tr key={upload.id} className="border-t border-zinc-100">
                <td className="py-2">{upload.file_name}</td>
                <td>{upload.uploaded_by_username}</td>
                <td>{formatWhen(upload.uploaded_at)}</td>
                <td>{upload.message_count}</td>
                <td>{upload.duplicate_count || 0}</td>
                <td>{upload.status}</td>
                <td className="text-right">
                  <button type="button" onClick={() => void deleteUpload(upload.id)} className="text-red-600">
                    Delete upload
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
