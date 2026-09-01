"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, setSession } from "@/lib/api";
import type { AuthResponse, SignupPreview } from "@/lib/types";

type SignupFormProps = {
  initialCode?: string;
};

export function SignupForm({ initialCode = "" }: SignupFormProps) {
  const router = useRouter();
  const [code, setCode] = useState(initialCode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<SignupPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCode(initialCode);
  }, [initialCode]);

  useEffect(() => {
    const normalized = code.trim();
    if (normalized.length < 6) {
      setPreview(null);
      return;
    }
    void api<SignupPreview>(`/api/auth/signup/${encodeURIComponent(normalized)}`)
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [code]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<AuthResponse>("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({ code, email, password }),
      });
      setSession(result.token, result.user);
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-[#171717]">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl bg-[#f3efe6] p-8 shadow-xl"
      >
        <p className="text-xs uppercase tracking-[0.18em] text-emerald-700">Create account</p>
        <h1 className="mt-2 text-2xl font-semibold">Join WhatsApp Strategy Canvas</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Enter the personal signup code from your admin, then choose your email and password.
        </p>

        <label className="mt-6 block text-sm">
          Signup code
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="AB12CD34"
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono uppercase tracking-widest"
            required
          />
        </label>
        {preview ? (
          <p className="mt-2 text-xs text-emerald-700">
            Code valid
            {preview.note ? ` — ${preview.note}` : ""}
            {preview.workspace_name ? ` · joins ${preview.workspace_name}` : ""}
            {preview.uses_remaining > 1 ? ` · ${preview.uses_remaining} uses left` : ""}
          </p>
        ) : code.trim().length >= 6 ? (
          <p className="mt-2 text-xs text-red-600">This code is invalid or already used.</p>
        ) : null}

        <label className="mt-4 block text-sm">
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2"
            required
          />
        </label>
        <label className="mt-4 block text-sm">
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={8}
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2"
            required
          />
        </label>
        <p className="mt-1 text-xs text-zinc-500">At least 8 characters.</p>

        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={busy || !preview}
          className="mt-6 w-full rounded-md bg-zinc-900 py-2 text-white disabled:opacity-50"
        >
          {busy ? "Creating account..." : "Create account"}
        </button>
        <p className="mt-4 text-center text-sm text-zinc-600">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-emerald-800 underline">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
