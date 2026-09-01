"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, formatWhen, getUser } from "@/lib/api";
import { getActiveWorkspaceId, loadWorkspaces, workspaceQuery } from "@/lib/workspace";
import type { SignupCodeRecord, UploadRecord, UserRecord } from "@/lib/types";

export default function AdminPage() {
  const router = useRouter();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [signupCodes, setSignupCodes] = useState<SignupCodeRecord[]>([]);
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [codeNote, setCodeNote] = useState("");
  const [codeUses, setCodeUses] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const workspaceId = getActiveWorkspaceId();
    const uploadPromise = workspaceId
      ? api<UploadRecord[]>(`/api/uploads?${workspaceQuery()}`)
      : Promise.resolve([] as UploadRecord[]);
    const [nextUsers, nextCodes, nextUploads] = await Promise.all([
      api<UserRecord[]>("/api/admin/users"),
      api<SignupCodeRecord[]>("/api/admin/signup-codes"),
      uploadPromise,
    ]);
    setUsers(nextUsers);
    setSignupCodes(nextCodes);
    setUploads(nextUploads);
  }

  useEffect(() => {
    const me = getUser();
    if (me && me.role !== "admin") {
      router.replace("/");
      return;
    }
    void loadWorkspaces()
      .then(() => load())
      .catch((err) => setError(err instanceof Error ? err.message : "Admin load failed"));
  }, [router]);

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
    setNotice(`New password: ${result.temporary_password}`);
  }

  async function changeRole(userId: string, next: "admin" | "member") {
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
      <p className="mt-1 text-sm text-zinc-600">Team accounts and uploads for the active workspace.</p>
      {notice ? <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}
      {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}

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
        <p className="mt-1 text-sm text-zinc-600">Or create a login directly for someone on your team.</p>
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
            placeholder="Password (optional)"
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as "member" | "admin")}
            className="rounded-md border border-zinc-300 px-2 py-2 text-sm"
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
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
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-t border-zinc-100">
                <td className="py-2">{user.email || user.username}</td>
                <td className="capitalize">{user.role}</td>
                <td className="space-x-3 text-right">
                  <button type="button" onClick={() => void resetPassword(user.id)} className="text-emerald-700">
                    Reset password
                  </button>
                  <button
                    type="button"
                    onClick={() => void changeRole(user.id, user.role === "admin" ? "member" : "admin")}
                    className="text-zinc-600"
                  >
                    Change role
                  </button>
                  <button type="button" onClick={() => void removeUser(user.id)} className="text-red-600">
                    Remove
                  </button>
                </td>
              </tr>
            ))}
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
