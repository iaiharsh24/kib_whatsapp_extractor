import { api } from "@/lib/api";
import { readCache, writeCache } from "@/lib/cache";

let cache: Record<string, unknown> | null = null;

export async function loadPreferences() {
  const local = readCache<Record<string, unknown>>("preferences") || {};
  try {
    const remote = await api<Record<string, unknown>>("/api/preferences");
    cache = { ...local, ...remote };
    writeCache("preferences", cache);
  } catch {
    cache = local;
  }
  return cache;
}

export function getPreference<T>(key: string, fallback: T): T {
  if (!cache || !(key in cache)) return fallback;
  return cache[key] as T;
}

export async function savePreference(key: string, value: unknown) {
  if (!cache) cache = {};
  cache[key] = value;
  writeCache("preferences", cache);
  try {
    await api(`/api/preferences/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  } catch {
    // Keep the local value so nav/workspace choice survives a downed API.
  }
}
