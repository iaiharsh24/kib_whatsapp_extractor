"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, formatWhen, getUser } from "@/lib/api";
import type {
  DbOverview,
  DbSnapshotRecord,
  DbSnapshotResponse,
} from "@/lib/types";

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function DatabasePage() {
  const router = useRouter();
  const [overview, setOverview] = useState<DbOverview | null>(null);
  const [snapshots, setSnapshots] = useState<DbSnapshotRecord[]>([]);
  const [snapshotTotal, setSnapshotTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function load() {
    const [nextOverview, nextSnapshots] = await Promise.all([
      api<DbOverview>("/api/admin/db/overview"),
      api<DbSnapshotResponse>("/api/admin/db/snapshots?limit=100"),
    ]);
    setOverview(nextOverview);
    setSnapshots(nextSnapshots.items);
    setSnapshotTotal(nextSnapshots.total);
  }

  useEffect(() => {
    const me = getUser();
    if (!me || !me.is_super_admin) {
      router.replace("/admin");
      return;
    }
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load database overview"));
  }, [router]);

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function snapshotNow() {
    setBusy(true);
    try {
      await api<DbSnapshotRecord>("/api/admin/db/snapshots", { method: "POST", body: JSON.stringify({}) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Snapshot failed");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSnapshot(id: string) {
    if (!window.confirm("Delete this snapshot and its backup file?")) return;
    try {
      await api(`/api/admin/db/snapshots/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  function downloadUrl(id: string): string {
    return `/api/admin/db/snapshots/${id}/download`;
  }

  if (error) return <div className="p-6 text-sm text-red-600">{error}</div>;
  if (!overview) return <div className="p-6 text-sm text-zinc-500">Loading database overview…</div>;

  return (
    <div className="h-full overflow-auto p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Database</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Super-admin view of all uploaded zip files, organized by workspace and project. A snapshot of the
            database is recorded automatically every 6 hours.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void snapshotNow()}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {busy ? "Snapshotting…" : "Snapshot now"}
        </button>
      </div>

      <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-semibold">Totals ({overview.backend})</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Object.entries(overview.totals).map(([key, value]) => (
            <div key={key} className="rounded-lg bg-zinc-50 p-3">
              <p className="text-2xl font-semibold text-zinc-900">{value}</p>
              <p className="text-xs uppercase tracking-wide text-zinc-500">{key}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-semibold">Snapshots</h3>
        <p className="mt-1 text-sm text-zinc-600">
          {snapshotTotal} recorded snapshot{snapshotTotal === 1 ? "" : "s"}. The scheduler keeps the most recent 60.
        </p>
        {snapshots.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No snapshots yet. The first scheduled snapshot runs shortly after startup.</p>
        ) : (
          <table className="mt-4 w-full text-left text-sm">
            <thead className="text-xs uppercase text-zinc-500">
              <tr>
                <th className="py-2">When</th>
                <th>Kind</th>
                <th>Backend</th>
                <th>Size</th>
                <th>Stats</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snap) => {
                const stats = snap.stats || {};
                const statLine = [
                  `users ${stats.users ?? "?"}`,
                  `projects ${stats.projects ?? "?"}`,
                  `uploads ${stats.uploads ?? "?"}`,
                  `messages ${stats.messages ?? "?"}`,
                ].join(" · ");
                return (
                  <tr key={snap.id} className="border-t border-zinc-100 align-top">
                    <td className="py-2">{formatWhen(snap.created_at)}</td>
                    <td>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${snap.kind === "manual" ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-600"}`}>
                        {snap.kind}
                      </span>
                    </td>
                    <td className="text-zinc-500">{snap.backend}</td>
                    <td>{formatBytes(snap.size_bytes)}</td>
                    <td className="text-[11px] text-zinc-500">{statLine}</td>
                    <td className="space-x-3 text-right">
                      <a
                        href={downloadUrl(snap.id)}
                        className="text-emerald-700 hover:underline"
                        download={snap.file_name}
                      >
                        Download
                      </a>
                      <button type="button" onClick={() => void deleteSnapshot(snap.id)} className="text-red-600 hover:underline">
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-semibold">All zip files by project</h3>
        <p className="mt-1 text-sm text-zinc-600">Every upload across every workspace, grouped under its project.</p>
        <div className="mt-4 space-y-3">
          {overview.workspaces.length === 0 ? (
            <p className="text-sm text-zinc-500">No workspaces yet.</p>
          ) : (
            overview.workspaces.map((ws) => (
              <div key={ws.id} className="rounded-lg border border-zinc-100">
                <div className="flex flex-wrap items-center justify-between gap-2 bg-zinc-50 px-4 py-2.5">
                  <div>
                    <p className="font-semibold text-zinc-800">{ws.name}</p>
                    <p className="text-[11px] text-zinc-500">
                      owner {ws.owner_username || "—"} · {ws.project_count} projects · {ws.upload_count} uploads · {ws.message_count} messages
                    </p>
                  </div>
                </div>
                <div className="divide-y divide-zinc-50">
                  {ws.projects.length === 0 ? (
                    <p className="px-4 py-3 text-xs text-zinc-500">No projects in this workspace.</p>
                  ) : (
                    ws.projects.map((project) => {
                      const open = expanded.has(project.id);
                      return (
                        <div key={project.id} className="px-4 py-2.5">
                          <button
                            type="button"
                            onClick={() => toggle(project.id)}
                            className="flex w-full items-center justify-between gap-2 text-left"
                          >
                            <span className="font-medium text-zinc-800">
                              {open ? "▾" : "▸"} {project.name}
                            </span>
                            <span className="text-[11px] text-zinc-500">
                              {project.uploads.length} zip{project.uploads.length === 1 ? "" : "s"} · {project.message_count} messages · {project.canvas_count} canvas{project.canvas_count === 1 ? "" : "es"}
                            </span>
                          </button>
                          {open ? (
                            project.uploads.length === 0 ? (
                              <p className="mt-2 pl-5 text-xs text-zinc-500">No zip files uploaded to this project yet.</p>
                            ) : (
                              <table className="mt-2 w-full pl-5 text-left text-xs">
                                <thead className="uppercase text-zinc-400">
                                  <tr>
                                    <th className="py-1.5">File</th>
                                    <th>By</th>
                                    <th>Uploaded</th>
                                    <th>Messages</th>
                                    <th>Skipped</th>
                                    <th>Status</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {project.uploads.map((upload) => (
                                    <tr key={upload.id} className="border-t border-zinc-50">
                                      <td className="py-1.5 font-medium text-zinc-700">{upload.file_name}</td>
                                      <td className="text-zinc-500">{upload.uploaded_by_username || "—"}</td>
                                      <td className="text-zinc-500">{formatWhen(upload.uploaded_at)}</td>
                                      <td>{upload.message_count}</td>
                                      <td>{upload.duplicate_count}</td>
                                      <td>
                                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                                          upload.status === "completed" ? "bg-emerald-50 text-emerald-700"
                                            : upload.status === "failed" ? "bg-red-50 text-red-700"
                                              : "bg-amber-50 text-amber-700"
                                        }`}>
                                          {upload.status}
                                        </span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
