"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, formatWhen } from "@/lib/api";
import type { ControlTables } from "@/lib/types";

type TableTab =
  | "users"
  | "workspaces"
  | "members"
  | "projects"
  | "canvases"
  | "uploads"
  | "messages"
  | "tags"
  | "signup_codes"
  | "activity";

const TABS: { id: TableTab; label: string }[] = [
  { id: "users", label: "Users" },
  { id: "workspaces", label: "Workspaces" },
  { id: "members", label: "Members" },
  { id: "projects", label: "Projects" },
  { id: "canvases", label: "Canvases" },
  { id: "uploads", label: "Uploads" },
  { id: "messages", label: "Messages" },
  { id: "tags", label: "Tags" },
  { id: "signup_codes", label: "Signup codes" },
  { id: "activity", label: "Activity" },
];

function TableShell({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200">
      <div className="border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-700">
        {title} <span className="text-zinc-400">({count})</span>
      </div>
      <div className="max-h-[560px] overflow-auto">{children}</div>
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="sticky top-0 bg-zinc-50 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{children}</th>;
}

function Td({
  children,
  className = "",
  title,
}: {
  children?: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td title={title} className={`border-t border-zinc-100 px-3 py-2 align-top text-xs text-zinc-700 ${className}`}>
      {children}
    </td>
  );
}

export default function ControlDataTables() {
  const [tables, setTables] = useState<ControlTables | null>(null);
  const [tab, setTab] = useState<TableTab>("users");
  const [messageOffset, setMessageOffset] = useState(0);
  const [messageLimit] = useState(100);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const data = await api<ControlTables>(
          `/api/admin/control/tables?message_limit=${messageLimit}&message_offset=${messageOffset}`,
        );
        setTables(data);
        setError(null);
        setLoading(false);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error("Failed to load tables");
        if (attempt < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 800 * (attempt + 1)));
        }
      }
    }
    setError(lastError?.message || "Failed to load tables");
    setLoading(false);
  }, [messageLimit, messageOffset]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (loading || !tables) return <p className="text-sm text-zinc-500">Loading data tables…</p>;

  return (
    <div>
      <div className="flex flex-wrap gap-1 border-b border-zinc-200 pb-2">
        {TABS.map((item) => {
          let count = 0;
          if (item.id === "users") count = tables.users.length;
          if (item.id === "workspaces") count = tables.workspaces.length;
          if (item.id === "members") count = tables.workspace_members.length;
          if (item.id === "projects") count = tables.projects.length;
          if (item.id === "canvases") count = tables.canvases.length;
          if (item.id === "uploads") count = tables.uploads.length;
          if (item.id === "messages") count = tables.messages.total;
          if (item.id === "tags") count = tables.tags.length;
          if (item.id === "signup_codes") count = tables.signup_codes.length;
          if (item.id === "activity") count = tables.activity_logs.total;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                tab === item.id ? "bg-emerald-700 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
              }`}
            >
              {item.label} ({count})
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {tab === "users" ? (
          <TableShell title="users" count={tables.users.length}>
            <table className="w-full min-w-[720px]">
              <thead>
                <tr>
                  <Th>Email</Th>
                  <Th>Username</Th>
                  <Th>Role</Th>
                  <Th>Workspaces</Th>
                  <Th>Projects</Th>
                  <Th>Uploads</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {tables.users.map((row) => (
                  <tr key={row.id} className="hover:bg-zinc-50">
                    <Td>{row.email || "—"}</Td>
                    <Td className="font-mono text-[11px]">{row.username}</Td>
                    <Td>
                      {row.role}
                      {row.is_super_admin ? " · super" : ""}
                    </Td>
                    <Td>{row.workspace_count}</Td>
                    <Td>{row.projects_created}</Td>
                    <Td>{row.uploads_count}</Td>
                    <Td>{formatWhen(row.created_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : null}

        {tab === "workspaces" ? (
          <TableShell title="workspaces" count={tables.workspaces.length}>
            <table className="w-full min-w-[800px]">
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Owner</Th>
                  <Th>Members</Th>
                  <Th>Projects</Th>
                  <Th>Uploads</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {tables.workspaces.map((row) => (
                  <tr key={row.id} className="hover:bg-zinc-50">
                    <Td className="font-medium">{row.name}</Td>
                    <Td>{row.owner_email || row.owner_username || row.owner_id}</Td>
                    <Td>{row.member_count}</Td>
                    <Td>{row.project_count}</Td>
                    <Td>{row.upload_count}</Td>
                    <Td>{formatWhen(row.created_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : null}

        {tab === "members" ? (
          <TableShell title="workspace_members" count={tables.workspace_members.length}>
            <table className="w-full min-w-[800px]">
              <thead>
                <tr>
                  <Th>Workspace</Th>
                  <Th>User</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Joined</Th>
                </tr>
              </thead>
              <tbody>
                {tables.workspace_members.map((row) => (
                  <tr key={row.id} className="hover:bg-zinc-50">
                    <Td>{row.workspace_name || row.workspace_id}</Td>
                    <Td>{row.username || row.user_id}</Td>
                    <Td>{row.email || "—"}</Td>
                    <Td>{row.role}</Td>
                    <Td>{formatWhen(row.created_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : null}

        {tab === "projects" ? (
          <TableShell title="projects" count={tables.projects.length}>
            <table className="w-full min-w-[900px]">
              <thead>
                <tr>
                  <Th>Project</Th>
                  <Th>Workspace</Th>
                  <Th>Created by</Th>
                  <Th>Canvases</Th>
                  <Th>Uploads</Th>
                  <Th>Created</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {tables.projects.map((row) => (
                  <tr key={row.id} className="hover:bg-zinc-50">
                    <Td className="font-medium">{row.name}</Td>
                    <Td>{row.workspace_name || "—"}</Td>
                    <Td>{row.created_by_username || row.created_by}</Td>
                    <Td>{row.canvas_count}</Td>
                    <Td>{row.upload_count}</Td>
                    <Td>{formatWhen(row.created_at)}</Td>
                    <Td>
                      <Link href={`/projects/${row.id}`} className="text-emerald-700 hover:underline">
                        Open
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : null}

        {tab === "canvases" ? (
          <TableShell title="project_canvas" count={tables.canvases.length}>
            <table className="w-full min-w-[900px]">
              <thead>
                <tr>
                  <Th>Canvas</Th>
                  <Th>Project</Th>
                  <Th>Nodes</Th>
                  <Th>Edges</Th>
                  <Th>Frames</Th>
                  <Th>Created</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {tables.canvases.map((row) => (
                  <tr key={row.id} className="hover:bg-zinc-50">
                    <Td className="font-medium">{row.name}</Td>
                    <Td>{row.project_name || row.project_id}</Td>
                    <Td>{row.node_count}</Td>
                    <Td>{row.edge_count}</Td>
                    <Td>{row.frame_count}</Td>
                    <Td>{formatWhen(row.created_at)}</Td>
                    <Td>
                      <Link href={`/projects/${row.project_id}`} className="text-emerald-700 hover:underline">
                        Open
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : null}

        {tab === "uploads" ? (
          <TableShell title="uploads" count={tables.uploads.length}>
            <table className="w-full min-w-[1000px]">
              <thead>
                <tr>
                  <Th>File</Th>
                  <Th>Project</Th>
                  <Th>Uploaded by</Th>
                  <Th>Messages</Th>
                  <Th>Skipped</Th>
                  <Th>Status</Th>
                  <Th>Chat</Th>
                  <Th>Uploaded</Th>
                </tr>
              </thead>
              <tbody>
                {tables.uploads.map((row) => (
                  <tr key={row.id} className="hover:bg-zinc-50">
                    <Td className="max-w-[200px] truncate font-medium" title={row.file_name}>
                      {row.file_name}
                    </Td>
                    <Td>{row.project_id || "—"}</Td>
                    <Td>{row.uploaded_by_username || row.uploaded_by}</Td>
                    <Td>{row.message_count}</Td>
                    <Td>{row.duplicate_count || 0}</Td>
                    <Td>{row.status}</Td>
                    <Td>{row.chat_name || "—"}</Td>
                    <Td>{formatWhen(row.uploaded_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : null}

        {tab === "messages" ? (
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
              <span>
                Showing {tables.messages.items.length} of {tables.messages.total} messages
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={messageOffset <= 0}
                  onClick={() => setMessageOffset((v) => Math.max(0, v - messageLimit))}
                  className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={messageOffset + messageLimit >= tables.messages.total}
                  onClick={() => setMessageOffset((v) => v + messageLimit)}
                  className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
            <TableShell title="messages" count={tables.messages.total}>
              <table className="w-full min-w-[1100px]">
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Sender</Th>
                    <Th>Type</Th>
                    <Th>Chat</Th>
                    <Th>Preview</Th>
                    <Th>Upload</Th>
                    <Th>Project</Th>
                    <Th>Media</Th>
                  </tr>
                </thead>
                <tbody>
                  {tables.messages.items.map((row) => (
                    <tr key={row.id} className="hover:bg-zinc-50">
                      <Td>{formatWhen(row.timestamp)}</Td>
                      <Td>{row.sender}</Td>
                      <Td>{row.type}</Td>
                      <Td>{row.chat_name || "—"}</Td>
                      <Td className="max-w-xs truncate" title={row.preview}>
                        {row.preview || "—"}
                      </Td>
                      <Td className="max-w-[140px] truncate" title={row.upload_file || row.upload_id}>
                        {row.upload_file || row.upload_id}
                      </Td>
                      <Td>{row.project_name || "—"}</Td>
                      <Td>{row.has_media ? "yes" : "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
          </div>
        ) : null}

        {tab === "tags" ? (
          <TableShell title="tags" count={tables.tags.length}>
            <table className="w-full min-w-[600px]">
              <thead>
                <tr>
                  <Th>Tag</Th>
                  <Th>Workspace</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {tables.tags.map((row) => (
                  <tr key={row.id} className="hover:bg-zinc-50">
                    <Td className="font-medium">{row.name}</Td>
                    <Td>{row.workspace_name || row.workspace_id}</Td>
                    <Td>{formatWhen(row.created_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : null}

        {tab === "signup_codes" ? (
          <TableShell title="signup_codes" count={tables.signup_codes.length}>
            <table className="w-full min-w-[800px]">
              <thead>
                <tr>
                  <Th>Code</Th>
                  <Th>Label</Th>
                  <Th>Uses</Th>
                  <Th>Workspace</Th>
                  <Th>Created by</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {tables.signup_codes.map((row) => (
                  <tr key={row.id} className="hover:bg-zinc-50">
                    <Td className="font-mono">{row.code}</Td>
                    <Td>{row.note || "—"}</Td>
                    <Td>
                      {row.used_count}/{row.max_uses}
                    </Td>
                    <Td>{row.workspace_name || "—"}</Td>
                    <Td>{row.created_by || "—"}</Td>
                    <Td>{row.revoked ? "revoked" : "active"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : null}

        {tab === "activity" ? (
          <TableShell title="activity_logs" count={tables.activity_logs.total}>
            <table className="w-full min-w-[900px]">
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>User</Th>
                  <Th>Role</Th>
                  <Th>Action</Th>
                  <Th>Resource</Th>
                </tr>
              </thead>
              <tbody>
                {tables.activity_logs.items.map((row) => (
                  <tr key={row.id} className="hover:bg-zinc-50">
                    <Td>{formatWhen(row.created_at)}</Td>
                    <Td>{row.username}</Td>
                    <Td>{row.user_role || "—"}</Td>
                    <Td>{row.action}</Td>
                    <Td>
                      {row.resource_name || row.resource_type || "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : null}
      </div>
    </div>
  );
}
