import { api } from "@/lib/api";

let cache: Record<string, unknown> | null = null;

export async function loadPreferences() {
  try {
    cache = await api<Record<string, unknown>>("/api/preferences");
  } catch {
    cache = {};
  }
  return cache;
}

export function getPreference<T>(key: string, fallback: T): T {
  if (!cache || !(key in cache)) return fallback;
  return cache[key] as T;
}

export async function savePreference(key: string, value: unknown) {
  await api(`/api/preferences/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
  if (!cache) cache = {};
  cache[key] = value;
}
