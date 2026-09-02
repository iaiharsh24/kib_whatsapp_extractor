import { getUser } from "@/lib/api";

const PREFIX = "wa_cache_v1";

export type CanvasDraft = {
  projectId: string;
  canvasId: string;
  nodes: unknown[];
  edges: unknown[];
  frames: unknown[];
  viewport: { x: number; y: number; zoom: number } | null;
  updatedAt: number;
  dirty: boolean;
};

function scope(): string {
  return getUser()?.id || "anon";
}

function storageKey(name: string): string {
  return `${PREFIX}:${scope()}:${name}`;
}

export function readCache<T>(name: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(name));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeCache<T>(name: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(name), JSON.stringify(value));
  } catch {
    // Quota or private mode — keep going with memory-only UI state.
  }
}

export function removeCache(name: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(name));
  } catch {
    // ignore
  }
}

export function readCanvasDraft(projectId: string, canvasId: string): CanvasDraft | null {
  return readCache<CanvasDraft>(`canvas:${projectId}:${canvasId}`);
}

export function writeCanvasDraft(draft: CanvasDraft): void {
  writeCache(`canvas:${draft.projectId}:${draft.canvasId}`, draft);
}

export function markCanvasDraftSaved(projectId: string, canvasId: string): void {
  const draft = readCanvasDraft(projectId, canvasId);
  if (!draft) return;
  writeCanvasDraft({ ...draft, dirty: false });
}

export function clearCanvasDraft(projectId: string, canvasId: string): void {
  removeCache(`canvas:${projectId}:${canvasId}`);
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 800): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error("Request failed");
      if (attempt < attempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs * (attempt + 1)));
      }
    }
  }
  throw lastError ?? new Error("Request failed");
}
