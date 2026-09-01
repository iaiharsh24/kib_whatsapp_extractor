"use client";

import { FormEvent, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, getToken, setSession } from "@/lib/api";
import type { AuthResponse, InvitePreview } from "@/lib/types";

export default function InvitePage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = params.code;
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loggedIn = Boolean(getToken());

  useEffect(() => {
    void api<InvitePreview>(`/api/invites/${code}`)
      .then(setPreview)
      .catch((err) => setError(err instanceof Error ? err.message : "Invite not found"));
  }, [code]);

  async function accept(existing = loggedIn) {
    setBusy(true);
    setError(null);
    try {
      const headers: HeadersInit = {};
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const result = await api<AuthResponse & { workspace: { id: string } }>(`/api/invites/${code}/accept`, {
        method: "POST",
        headers,
        body: JSON.stringify(existing ? {} : { email: email.trim(), password }),
      });
      setSession(result.token, result.user);
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join workspace");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await accept(false);
  }

  if (!preview && !error) {
    return <div className="flex h-screen items-center justify-center text-sm text-zinc-500">Loading invite...</div>;
  }

  return (
    <div className="flex h-screen items-center justify-center bg-[#171717] px-4">
      <div className="w-full max-w-md rounded-2xl bg-[#f3efe6] p-8 shadow-xl">
        {preview ? (
          <>
            <p className="text-xs uppercase tracking-[0.18em] text-emerald-700">Workspace invite</p>
            <h1 className="mt-2 text-2xl font-semibold">{preview.workspace_name}</h1>
            <p className="mt-2 text-sm text-zinc-600">
              {preview.invited_by} invited you to join as {preview.role}.
            </p>
          </>
        ) : null}
        {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}
        {preview && loggedIn ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void accept(true)}
            className="mt-6 w-full rounded-md bg-zinc-900 py-2 text-white disabled:opacity-50"
          >
            {busy ? "Joining..." : "Join workspace"}
          </button>
        ) : null}
        {preview && !loggedIn ? (
          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <label className="block text-sm">
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2"
              />
            </label>
            <label className="block text-sm">
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2"
              />
            </label>
            <button type="submit" disabled={busy} className="w-full rounded-md bg-zinc-900 py-2 text-white disabled:opacity-50">
              {busy ? "Creating account..." : "Create account and join"}
            </button>
            <p className="text-center text-xs text-zinc-500">
              Already have an account?{" "}
              <a href="/login" className="text-emerald-700 underline">
                Sign in
              </a>{" "}
              first, then open this link again.
            </p>
          </form>
        ) : null}
      </div>
    </div>
  );
}
