"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, downloadAuthenticated, formatWhen, getUser } from "@/lib/api";
import { refreshWorkspaces, setActiveWorkspaceId } from "@/lib/workspace";
import type {
  ControlOverview,
  ControlUserRow,
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

function UserCard({
  row,
  expanded,
  onToggle,
  onExport,
  busyExport,
}: {
  row: ControlUserRow;
  expanded: boolean;
  onToggle: () => void;
  onExport: (includeMessages: boolean) => void;
  busyExport: boolean;
}) {
  const label = row.user.email || row.user.username;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-zinc-50"
      >
        <div>
          <p className="font-semibold text-zinc-900">
            {expanded ? "▾" : "▸"} {label}
          </p>
          <p className="text-xs text-zinc-500">
            {row.user.role}
            {row.user.is_super_admin ? " · super admin" : ""} · {row.totals.projects_created} projects ·{" "}
            {row.totals.canvases} canvases · {row.totals.uploads} uploads · {row.totals.messages_in_projects}{" "}
            messages
          </p>
        </div>
        <div className="flex flex-wrap gap-2" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            disabled={busyExport}
            onClick={() => onExport(false)}
            className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Backup JSON
          </button>
          <button
            type="button"
            disabled={busyExport}
            onClick={() => onExport(true)}
            className="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            Full backup
          </button>
        </div>
      </button>

      {expanded ? (
        <div className="space-y-4 border-t border-zinc-100 px-4 py-4 text-sm">
          {(row.owned_workspaces.length > 0 || row.member_workspaces.length > 0) && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Workspaces</p>
              <ul className="mt-2 space-y-1 text-xs text-zinc-700">
                {row.owned_workspaces.map((ws) => (
                  <li key={ws.id}>
                    <button
                      type="button"
                      onClick={() => void setActiveWorkspaceId(ws.id).then(() => refreshWorkspaces())}
                      className="text-emerald-700 hover:underline"
                    >
                      {ws.name}
                    </button>{" "}
                    · owner · {ws.project_count} projects
                  </li>
                ))}
                {row.member_workspaces.map((ws) => (
                  <li key={ws.id}>
                    <button
                      type="button"
                      onClick={() => void setActiveWorkspaceId(ws.id).then(() => refreshWorkspaces())}
                      className="text-emerald-700 hover:underline"
                    >
                      {ws.name}
                    </button>{" "}
                    · {ws.role} · {ws.project_count} projects
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Projects created</p>
            {row.projects_created.length === 0 ? (
              <p className="mt-2 text-xs text-zinc-500">No projects created by this user.</p>
            ) : (
              <div className="mt-2 space-y-3">
                {row.projects_created.map((project) => (
                  <div key={project.id} className="rounded-md border border-zinc-100 bg-zinc-50 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-zinc-900">{project.name}</p>
                        <p className="text-[11px] text-zinc-500">
                          {project.workspace_name || "No workspace"} · {project.upload_count} zips ·{" "}
                          {project.message_count} messages · {project.canvas_count} canvas
                          {project.canvas_count === 1 ? "" : "es"}
                        </p>
                      </div>
                      <Link
                        href={`/projects/${project.id}`}
                        className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs text-white hover:bg-zinc-800"
                      >
                        Open project
                      </Link>
                    </div>
                    {project.canvases.length > 0 ? (
                      <ul className="mt-2 space-y-1 text-xs text-zinc-600">
                        {project.canvases.map((canvas) => (
                          <li key={canvas.id}>
                            {canvas.name} · {canvas.node_count} nodes · {canvas.edge_count} edges ·{" "}
                            {formatWhen(canvas.created_at)}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {project.uploads.length > 0 ? (
                      <ul className="mt-2 space-y-1 text-[11px] text-zinc-500">
                        {project.uploads.map((upload) => (
                          <li key={upload.id}>
                            {upload.file_name} · {upload.message_count} msgs · {upload.status}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function ControlPage() {
  const router = useRouter();
  const [control, setControl] = useState<ControlOverview | null>(null);
  const [dbOverview, setDbOverview] = useState<DbOverview | null>(null);
  const [snapshots, setSnapshots] = useState<DbSnapshotRecord[]>([]);
  const [snapshotTotal, setSnapshotTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState<string | null>(null);
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());

  async function load() {
    const [nextControl, nextDb, nextSnapshots] = await Promise.all([
      api<ControlOverview>("/api/admin/control/overview"),
      api<DbOverview>("/api/admin/db/overview"),
      api<DbSnapshotResponse>("/api/admin/db/snapshots?limit=100"),
    ]);
    setControl(nextControl);
    setDbOverview(nextDb);
    setSnapshots(nextSnapshots.items);
    setSnapshotTotal(nextSnapshots.total);
  }

  useEffect(() => {
    const me = getUser();
    if (!me?.is_super_admin) {
      router.replace("/admin");
      return;
    }
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load control center"));
  }, [router]);

  function toggleUser(id: string) {
    setExpandedUsers((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleProject(id: string) {
    setExpandedProjects((current) => {
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

  async function exportUser(userId: string, includeMessages: boolean) {
    setExportBusy(userId);
    try {
      const suffix = includeMessages ? "full" : "summary";
      await downloadAuthenticated(
        `/api/admin/control/users/${userId}/export?include_messages=${includeMessages ? "true" : "false"}`,
        `user-backup-${suffix}-${userId}.json`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExportBusy(null);
    }
  }

  if (error) return <div className="p-6 text-sm text-red-600">{error}</div>;
  if (!control || !dbOverview) return <div className="p-6 text-sm text-zinc-500">Loading control center…</div>;

  return (
    <div className="h-full overflow-auto p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Control center</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Full visibility for Harsh — every user, project, canvas, and upload. You can open any project and download
            per-user backups.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void snapshotNow()}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {busy ? "Snapshotting…" : "Snapshot entire database"}
        </button>
      </div>

      <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-semibold">Platform totals</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Object.entries(control.totals).map(([key, value]) => (
            <div key={key} className="rounded-lg bg-zinc-50 p-3">
              <p className="text-2xl font-semibold text-zinc-900">{value}</p>
              <p className="text-xs uppercase tracking-wide text-zinc-500">{key}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-semibold">All users ({control.users.length})</h3>
        <p className="mt-1 text-sm text-zinc-600">
          Expand a user to see workspaces, projects, canvases, and uploads. Use Backup JSON for canvases + metadata, or
          Full backup to include every message.
        </p>
        <div className="mt-4 space-y-3">
          {control.users.map((row) => (
            <UserCard
              key={row.user.id}
              row={row}
              expanded={expandedUsers.has(row.user.id)}
              onToggle={() => toggleUser(row.user.id)}
              onExport={(includeMessages) => void exportUser(row.user.id, includeMessages)}
              busyExport={exportBusy === row.user.id}
            />
          ))}
        </div>
      </section>

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-semibold">Database snapshots ({dbOverview.backend})</h3>
        <p className="mt-1 text-sm text-zinc-600">
          Automatic backup every 6 hours. {snapshotTotal} snapshot{snapshotTotal === 1 ? "" : "s"} on record.
        </p>
        {snapshots.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No snapshots yet.</p>
        ) : (
          <table className="mt-4 w-full text-left text-sm">
            <thead className="text-xs uppercase text-zinc-500">
              <tr>
                <th className="py-2">When</th>
                <th>Kind</th>
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
                  <tr key={snap.id} className="border-t border-zinc-100">
                    <td className="py-2">{formatWhen(snap.created_at)}</td>
                    <td>{snap.kind}</td>
                    <td>{formatBytes(snap.size_bytes)}</td>
                    <td className="text-[11px] text-zinc-500">{statLine}</td>
                    <td className="text-right">
                      <a
                        href={`/api/admin/db/snapshots/${snap.id}/download`}
                        className="text-emerald-700 hover:underline"
                        download={snap.file_name}
                      >
                        Download
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="font-semibold">All uploads by workspace</h3>
        <div className="mt-4 space-y-3">
          {dbOverview.workspaces.map((ws) => (
            <div key={ws.id} className="rounded-lg border border-zinc-100">
              <div className="bg-zinc-50 px-4 py-2.5">
                <p className="font-semibold text-zinc-800">{ws.name}</p>
                <p className="text-[11px] text-zinc-500">
                  owner {ws.owner_username || "—"} · {ws.project_count} projects · {ws.upload_count} uploads
                </p>
              </div>
              <div className="divide-y divide-zinc-50">
                {ws.projects.map((project) => {
                  const open = expandedProjects.has(project.id);
                  return (
                    <div key={project.id} className="px-4 py-2.5">
                      <button
                        type="button"
                        onClick={() => toggleProject(project.id)}
                        className="flex w-full items-center justify-between gap-2 text-left text-sm"
                      >
                        <span className="font-medium">
                          {open ? "▾" : "▸"} {project.name}
                        </span>
                        <span className="text-[11px] text-zinc-500">
                          {project.uploads.length} zips · {project.message_count} msgs · {project.canvas_count} canvases
                        </span>
                      </button>
                      {open ? (
                        <div className="mt-2 flex flex-wrap gap-2 pl-5">
                          <Link
                            href={`/projects/${project.id}`}
                            className="rounded-md bg-zinc-900 px-2 py-1 text-xs text-white"
                          >
                            Open
                          </Link>
                          {project.uploads.map((upload) => (
                            <span key={upload.id} className="text-xs text-zinc-500">
                              {upload.file_name} ({upload.message_count})
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
