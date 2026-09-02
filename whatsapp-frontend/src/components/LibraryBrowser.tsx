"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api, fileSrc, formatWhen } from "@/lib/api";
import { readCache, writeCache } from "@/lib/cache";
import LibraryFilters, {
  EMPTY_LIBRARY_FILTERS,
  libraryQuery,
} from "@/components/LibraryFilters";
import { ItemMeta, MediaFrame, isImageMessage, isVideoMessage } from "@/components/MediaPreview";
import { TAGS_EVENT, uniqueTags } from "@/lib/tags";
import { getActiveWorkspaceId, workspaceQuery } from "@/lib/workspace";
import type {
  LibraryFilterOptions,
  LibraryFilterState,
  LibraryResponse,
  MessageRecord,
  ProjectRecord,
  UploadLibrarySummary,
  UploadRecord,
} from "@/lib/types";

export const LIBRARY_TABS = [
  { id: "all", label: "All" },
  { id: "chat", label: "Chats" },
  { id: "image", label: "Images" },
  { id: "reel", label: "Reels" },
  { id: "link", label: "Links" },
  { id: "document", label: "Documents" },
] as const;

export type LibraryTab = (typeof LIBRARY_TABS)[number]["id"];

const PAGE_SIZE = 48;

function tabCount(summary: UploadLibrarySummary | null, tab: LibraryTab, total: number): number {
  if (!summary) return total;
  if (tab === "all") return summary.counts.total;
  if (tab === "chat") return summary.counts.chat;
  if (tab === "image") return summary.counts.image;
  if (tab === "reel") return summary.counts.reel;
  if (tab === "link") return summary.counts.link;
  if (tab === "document") return summary.counts.document;
  return total;
}

function fallbackSummaries(uploads: UploadRecord[]): UploadLibrarySummary[] {
  return uploads.map((upload) => ({
    upload,
    counts: {
      chat: upload.message_count || 0,
      link: 0,
      document: 0,
      image: 0,
      reel: 0,
      total: upload.message_count || 0,
    },
  }));
}

export function LibraryMediaGrid({
  items,
  tab,
  knownTags,
  draggable = false,
}: {
  items: MessageRecord[];
  tab: LibraryTab;
  knownTags: string[];
  draggable?: boolean;
}) {
  if (items.length === 0) {
    return (
      <p className="px-1 py-10 text-center text-sm text-zinc-500">
        {tab === "all"
          ? "No extracts yet. Upload a WhatsApp export zip to populate this library."
          : `Nothing in “${tab}” for this zip. Try All or another zip.`}
      </p>
    );
  }

  if (tab === "image" || tab === "reel") {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {items.map((item) => (
          <div
            key={item.id}
            draggable={draggable}
            onDragStart={
              draggable
                ? (event) => {
                    event.dataTransfer.setData("application/json", JSON.stringify(item));
                  }
                : undefined
            }
            className={`overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200 ${
              draggable ? "cursor-grab hover:ring-emerald-500" : "hover:ring-emerald-400"
            }`}
          >
            <MediaFrame item={item} kind={tab} />
            <ItemMeta item={item} editable knownTags={knownTags} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item) => {
        const local = item.extracted_url?.startsWith("/api/files/") ? fileSrc(item.extracted_url) : null;
        const isImage = isImageMessage(item);
        const isVideo = isVideoMessage(item);
        const isDoc = item.type === "document";
        return (
          <div
            key={item.id}
            draggable={draggable}
            onDragStart={
              draggable
                ? (event) => {
                    event.dataTransfer.setData("application/json", JSON.stringify(item));
                  }
                : undefined
            }
            className={`flex gap-3 overflow-hidden rounded-xl border border-zinc-200 bg-white p-3 ${
              draggable ? "cursor-grab hover:border-emerald-500" : "hover:border-emerald-400"
            }`}
          >
            {local && isVideo ? (
              <div className="h-20 w-12 shrink-0 overflow-hidden rounded-lg bg-black">
                <video src={local} muted playsInline className="h-full w-full object-contain" />
              </div>
            ) : local && isImage ? (
              <div className="h-20 w-16 shrink-0 overflow-hidden rounded-lg bg-zinc-100">
                <img src={local} alt="" className="h-full w-full object-contain" />
              </div>
            ) : isDoc ? (
              <div className="flex h-20 w-16 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-[10px] font-semibold uppercase text-amber-800">
                Doc
              </div>
            ) : (
              <div className="flex h-20 w-16 shrink-0 items-center justify-center rounded-lg bg-zinc-50 text-[10px] font-semibold uppercase text-zinc-500">
                {item.type}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-wide text-emerald-700">{item.type}</p>
              <ItemMeta item={item} editable knownTags={knownTags} />
              {local && isDoc ? (
                <a
                  href={local}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-[11px] font-medium text-emerald-700 hover:underline"
                >
                  Open file
                </a>
              ) : null}
              {item.extracted_url?.startsWith("http") ? (
                <a
                  href={item.extracted_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block truncate text-[11px] text-emerald-700 hover:underline"
                >
                  {item.extracted_url}
                </a>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function LibraryBrowser({
  initialProjectId = null,
  embedded = false,
  onUpload,
  uploading = false,
  uploads = [],
  draggable = false,
}: {
  initialProjectId?: string | null;
  embedded?: boolean;
  onUpload?: (file: File) => Promise<void>;
  uploading?: boolean;
  uploads?: UploadRecord[];
  draggable?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [summaries, setSummaries] = useState<UploadLibrarySummary[]>([]);
  const [selectedUploadId, setSelectedUploadId] = useState<string | null>(null);
  const [library, setLibrary] = useState<MessageRecord[]>([]);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [libTab, setLibTab] = useState<LibraryTab>("all");
  const [offset, setOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState<LibraryFilterState>(EMPTY_LIBRARY_FILTERS);
  const [filterOptions, setFilterOptions] = useState<LibraryFilterOptions>({
    senders: [],
    tags: [],
    chats: [],
    sites: [],
  });
  const [localUploading, setLocalUploading] = useState(false);

  const selectedSummary = summaries.find((row) => row.upload.id === selectedUploadId) ?? null;
  const zipCount = summaries.length;
  const totalAll = useMemo(() => summaries.reduce((sum, row) => sum + row.counts.total, 0), [summaries]);
  const busy = uploading || localUploading;

  useEffect(() => {
    if (initialProjectId) {
      setProjectId(initialProjectId);
      return;
    }
    const workspaceId = getActiveWorkspaceId();
    if (!workspaceId) return;
    void api<ProjectRecord[]>(`/api/projects?${workspaceQuery()}`)
      .then((rows) => {
        setProjects(rows);
        setProjectId((current) => current || rows[0]?.id || null);
      })
      .catch(() => undefined);
  }, [initialProjectId]);

  const loadSummaries = useCallback(async () => {
    if (!projectId) {
      setSummaries([]);
      return;
    }
    const cacheKey = `library-uploads:${projectId}`;
    const stored = readCache<UploadLibrarySummary[]>(cacheKey);
    if (stored?.length) setSummaries(stored);
    try {
      const rows = await api<UploadLibrarySummary[]>(`/api/projects/${projectId}/library/uploads`);
      setSummaries(rows);
      writeCache(cacheKey, rows);
      setLoadError(null);
    } catch (err) {
      if (stored?.length) {
        setLoadError("Showing last saved zip list — server is temporarily unavailable.");
        return;
      }
      setLoadError(err instanceof Error ? err.message : "Could not load zip summaries");
      if (uploads.length) setSummaries(fallbackSummaries(uploads));
    }
  }, [projectId, uploads]);

  const loadLibrary = useCallback(
    async (nextOffset = 0, append = false) => {
      if (!projectId) {
        setLibrary([]);
        setLibraryTotal(0);
        return;
      }
      const cacheKey = `library:${projectId}:${libTab}:${selectedUploadId || "all"}:${nextOffset}`;
      if (!append) {
        const stored = readCache<LibraryResponse>(`library:${projectId}:${libTab}:${selectedUploadId || "all"}:0`);
        if (stored && nextOffset === 0) {
          setLibrary(stored.items);
          setLibraryTotal(stored.total);
        }
      }
      try {
        const params = libraryQuery(projectId, libTab, filters, {
          uploadId: selectedUploadId,
          limit: PAGE_SIZE,
        });
        params.set("offset", String(nextOffset));
        const lib = await api<LibraryResponse>(`/api/library?${params.toString()}`);
        setLibrary((current) => (append ? [...current, ...lib.items] : lib.items));
        setLibraryTotal(lib.total);
        setOffset(nextOffset + lib.items.length);
        if (nextOffset === 0) writeCache(cacheKey, lib);
        setLoadError(null);
      } catch (err) {
        if (!append) {
          setLoadError(err instanceof Error ? err.message : "Could not load library");
        }
      }
    },
    [projectId, libTab, filters, selectedUploadId],
  );

  useEffect(() => {
    void loadSummaries();
  }, [loadSummaries]);

  useEffect(() => {
    if (!projectId) return;
    const cacheKey = `library-filters:${projectId}`;
    const stored = readCache<LibraryFilterOptions>(cacheKey);
    if (stored) setFilterOptions((current) => ({ ...current, ...stored }));
    void api<LibraryFilterOptions>(`/api/library/filters?project_id=${encodeURIComponent(projectId)}`)
      .then((data) => {
        writeCache(cacheKey, data);
        setFilterOptions((current) => ({
          ...current,
          senders: data.senders,
          chats: data.chats,
          sites: data.sites,
          tags: data.tags?.length ? data.tags : current.tags,
        }));
      })
      .catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    setOffset(0);
    void loadLibrary(0, false);
  }, [loadLibrary]);

  useEffect(() => {
    function onTags(event: Event) {
      const detail = (event as CustomEvent<{ messageId: string; tags: string[] }>).detail;
      if (!detail?.messageId) return;
      setLibrary((current) =>
        current.map((item) => (item.id === detail.messageId ? { ...item, tags: detail.tags } : item)),
      );
      setFilterOptions((current) => ({ ...current, tags: uniqueTags([...current.tags, ...detail.tags]) }));
    }
    window.addEventListener(TAGS_EVENT, onTags);
    return () => window.removeEventListener(TAGS_EVENT, onTags);
  }, []);

  async function handleUpload(file: File) {
    if (!projectId) return;
    if (onUpload) {
      await onUpload(file);
      await loadSummaries();
      await loadLibrary(0, false);
      return;
    }
    setLocalUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      await api<UploadRecord>(`/api/uploads/file?project_id=${encodeURIComponent(projectId)}`, {
        method: "POST",
        body: form,
      });
      await loadSummaries();
      await loadLibrary(0, false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setLocalUploading(false);
    }
  }

  async function loadMore() {
    if (loadingMore || library.length >= libraryTotal) return;
    setLoadingMore(true);
    try {
      await loadLibrary(offset, true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className={`flex min-h-0 flex-1 ${embedded ? "" : "gap-0"}`}>
      <aside
        className={`flex shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-white ${
          embedded ? "w-72" : "w-80"
        }`}
      >
        {!embedded ? (
          <div className="border-b border-zinc-200 px-4 py-4">
            <h1 className="text-lg font-semibold text-zinc-900">Library</h1>
            <p className="mt-1 text-xs text-zinc-500">Browse extracts from each WhatsApp zip by media type.</p>
            {projects.length > 0 ? (
              <label className="mt-3 block text-xs text-zinc-600">
                Project
                <select
                  value={projectId || ""}
                  onChange={(event) => {
                    setProjectId(event.target.value || null);
                    setSelectedUploadId(null);
                  }}
                  className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        ) : null}

        {loadError ? (
          <p className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{loadError}</p>
        ) : null}

        <div className="border-b border-zinc-200 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-zinc-700">Zip files ({zipCount})</p>
            <label className="cursor-pointer rounded-md bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-800">
              {busy ? "Uploading…" : "Add zip"}
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,.txt"
                className="hidden"
                disabled={busy || !projectId}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void handleUpload(file).finally(() => {
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    });
                  }
                }}
              />
            </label>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2">
          <button
            type="button"
            onClick={() => setSelectedUploadId(null)}
            className={`mb-1.5 w-full rounded-lg border px-2.5 py-2 text-left text-xs transition ${
              selectedUploadId === null
                ? "border-emerald-600 bg-emerald-50 text-emerald-900"
                : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
            }`}
          >
            <p className="font-medium">All uploads</p>
            <p className="mt-0.5 text-[10px] text-zinc-500">
              {totalAll} messages · {zipCount} zip(s)
            </p>
          </button>

          {summaries.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-zinc-500">
              {projectId ? "Upload a WhatsApp export zip to get started." : "Select a project first."}
            </p>
          ) : (
            summaries.map((row) => {
              const active = selectedUploadId === row.upload.id;
              const statusColor =
                row.upload.status === "completed"
                  ? "text-emerald-600"
                  : row.upload.status === "failed"
                    ? "text-red-600"
                    : "text-amber-600";
              return (
                <button
                  key={row.upload.id}
                  type="button"
                  onClick={() => setSelectedUploadId(row.upload.id)}
                  className={`mb-1.5 w-full rounded-lg border px-2.5 py-2 text-left text-xs transition ${
                    active
                      ? "border-emerald-600 bg-emerald-50 text-emerald-900"
                      : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
                  }`}
                >
                  <p className="truncate font-medium" title={row.upload.file_name}>
                    {row.upload.file_name}
                  </p>
                  {row.upload.chat_name ? (
                    <p className="truncate text-[10px] text-zinc-500">{row.upload.chat_name}</p>
                  ) : null}
                  <p className="mt-1 text-[10px] text-zinc-500">
                    <span className={statusColor}>{row.upload.status}</span>
                    {" · "}
                    {row.counts.total} msgs
                    {row.counts.image > 0 ? ` · ${row.counts.image} img` : ""}
                    {row.counts.reel > 0 ? ` · ${row.counts.reel} reel` : ""}
                    {row.counts.document > 0 ? ` · ${row.counts.document} doc` : ""}
                    {row.counts.link > 0 ? ` · ${row.counts.link} link` : ""}
                  </p>
                  <p className="text-[10px] text-zinc-400">{formatWhen(row.upload.uploaded_at)}</p>
                </button>
              );
            })
          )}
        </div>

        {projectId && !embedded ? (
          <div className="border-t border-zinc-200 p-3">
            <Link
              href={`/projects/${projectId}`}
              className="block rounded-md border border-zinc-300 px-3 py-2 text-center text-xs font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Open strategy canvas
            </Link>
          </div>
        ) : null}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#f7f4ec]">
        <div className="border-b border-zinc-200 bg-white px-4 py-3">
          <LibraryFilters
            tabs={LIBRARY_TABS}
            tab={libTab}
            onTabChange={(id) => setLibTab(id as LibraryTab)}
            filters={filters}
            onChange={setFilters}
            options={filterOptions}
            total={tabCount(selectedSummary, libTab, libraryTotal)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <LibraryMediaGrid items={library} tab={libTab} knownTags={filterOptions.tags} draggable={draggable} />
          {library.length < libraryTotal ? (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : `Load more (${library.length} of ${libraryTotal})`}
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
