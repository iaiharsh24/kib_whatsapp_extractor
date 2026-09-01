"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, fileSrc, formatWhen } from "@/lib/api";
import LibraryFilters, {
  EMPTY_LIBRARY_FILTERS,
  libraryQuery,
} from "@/components/LibraryFilters";
import { MediaFrame, ItemMeta } from "@/components/MediaPreview";
import { TAGS_EVENT, uniqueTags } from "@/lib/tags";
import type {
  LibraryFilterOptions,
  LibraryFilterState,
  LibraryResponse,
  MessageRecord,
  TagRecord,
  UploadLibrarySummary,
  UploadRecord,
} from "@/lib/types";

const LIB_TABS = [
  { id: "image", label: "Images" },
  { id: "reel", label: "Reels" },
  { id: "link", label: "Links" },
  { id: "all", label: "All" },
] as const;

type LibTab = (typeof LIB_TABS)[number]["id"];

function tabCount(summary: UploadLibrarySummary | null, tab: LibTab, total: number): number {
  if (!summary) return total;
  if (tab === "all") return summary.counts.total;
  if (tab === "image") return summary.counts.image;
  if (tab === "reel") return summary.counts.reel;
  if (tab === "link") return summary.counts.link;
  return total;
}

function MediaList({
  items,
  libTab,
  knownTags,
}: {
  items: MessageRecord[];
  libTab: LibTab;
  knownTags: string[];
}) {
  if (items.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-xs text-zinc-500">
        No media in this category for the selected zip.
      </p>
    );
  }

  if (libTab === "image" || libTab === "reel") {
    return (
      <div className="grid grid-cols-1 gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("application/json", JSON.stringify(item));
            }}
            className="cursor-grab overflow-hidden rounded-lg ring-1 ring-zinc-200 hover:ring-emerald-500"
          >
            <MediaFrame item={item} kind={libTab} />
            <ItemMeta item={item} editable knownTags={knownTags} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      {items.map((item) => {
        const local = item.extracted_url?.startsWith("/api/files/") ? fileSrc(item.extracted_url) : null;
        const isImage =
          item.type === "image" ||
          item.type === "media_omitted" ||
          /\.(jpg|jpeg|png|gif|webp)$/i.test(item.extracted_filename || "");
        const isVideo =
          item.type === "reel" || /\.(mp4|webm|mov)$/i.test(item.extracted_filename || item.extracted_url || "");
        return (
          <div
            key={item.id}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("application/json", JSON.stringify(item));
            }}
            className="mb-2 flex cursor-grab gap-2 overflow-hidden rounded-lg border border-zinc-200 p-2 hover:border-emerald-500"
          >
            {local && isVideo ? (
              <div className="h-16 w-9 shrink-0 overflow-hidden rounded bg-black">
                <video src={local} muted playsInline className="h-full w-full object-contain" />
              </div>
            ) : local && isImage ? (
              <div className="h-16 w-[51px] shrink-0 overflow-hidden rounded bg-zinc-100">
                <img src={local} alt="" className="h-full w-full object-contain" />
              </div>
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase text-emerald-700">{item.type}</p>
              <ItemMeta item={item} editable knownTags={knownTags} />
            </div>
          </div>
        );
      })}
    </>
  );
}

export default function ProjectLibraryPanel({
  projectId,
  uploads,
  onUpload,
  uploading,
  collapsed,
  onToggleCollapsed,
}: {
  projectId: string;
  uploads: UploadRecord[];
  onUpload: (file: File) => Promise<void>;
  uploading: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [summaries, setSummaries] = useState<UploadLibrarySummary[]>([]);
  const [selectedUploadId, setSelectedUploadId] = useState<string | null>(null);
  const [library, setLibrary] = useState<MessageRecord[]>([]);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [libTab, setLibTab] = useState<LibTab>("image");
  const [filters, setFilters] = useState<LibraryFilterState>(EMPTY_LIBRARY_FILTERS);
  const [filterOptions, setFilterOptions] = useState<LibraryFilterOptions>({
    senders: [],
    tags: [],
    chats: [],
    sites: [],
  });

  const selectedSummary = summaries.find((row) => row.upload.id === selectedUploadId) ?? null;

  const loadSummaries = useCallback(async () => {
    const rows = await api<UploadLibrarySummary[]>(`/api/projects/${projectId}/library/uploads`);
    setSummaries(rows);
  }, [projectId]);

  const loadLibrary = useCallback(async () => {
    const params = libraryQuery(projectId, libTab, filters, {
      uploadId: selectedUploadId,
      limit: 60,
    });
    const lib = await api<LibraryResponse>(`/api/library?${params.toString()}`);
    setLibrary(lib.items);
    setLibraryTotal(lib.total);
  }, [projectId, libTab, filters, selectedUploadId]);

  useEffect(() => {
    void loadSummaries().catch(() => undefined);
  }, [loadSummaries, uploads]);

  useEffect(() => {
    void api<LibraryFilterOptions>(`/api/library/filters?project_id=${encodeURIComponent(projectId)}`)
      .then((data) =>
        setFilterOptions((current) => ({
          ...current,
          senders: data.senders,
          chats: data.chats,
          sites: data.sites,
          tags: data.tags?.length ? data.tags : current.tags,
        })),
      )
      .catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    void loadLibrary().catch(() => undefined);
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

  const totalAll = summaries.reduce((sum, row) => sum + row.counts.total, 0);

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-white">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex flex-1 items-center justify-center border-b border-zinc-200 py-3 text-[11px] uppercase tracking-wide text-zinc-500 hover:bg-zinc-50"
          title="Expand media library"
        >
          <span className="rotate-90 whitespace-nowrap">Media</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-white">
      <button
        type="button"
        onClick={onToggleCollapsed}
        className="border-b border-zinc-200 px-3 py-3 text-left hover:bg-zinc-50"
      >
        <span className="flex items-start justify-between gap-2">
          <span>
            <h2 className="font-semibold">Media library</h2>
            <p className="text-xs text-zinc-500">Browse by zip upload, then drag onto the canvas.</p>
          </span>
          <Chevron dir="left" />
        </span>
      </button>

      <div className="border-b border-zinc-200 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-zinc-700">Zip files ({summaries.length})</p>
          <label className="cursor-pointer rounded-md bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-800">
            {uploading ? "Uploading…" : "Add zip"}
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,.txt"
              className="hidden"
              disabled={uploading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onUpload(file).finally(() => {
                  if (fileInputRef.current) fileInputRef.current.value = "";
                });
              }}
            />
          </label>
        </div>
      </div>

      <div className="max-h-[34%] overflow-auto border-b border-zinc-200 p-2">
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
          <p className="mt-0.5 text-[10px] text-zinc-500">{totalAll} messages · {summaries.length} zip(s)</p>
        </button>

        {summaries.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-zinc-500">Upload a WhatsApp export zip to get started.</p>
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
                  {row.counts.link > 0 ? ` · ${row.counts.link} link` : ""}
                </p>
                <p className="text-[10px] text-zinc-400">{formatWhen(row.upload.uploaded_at)}</p>
              </button>
            );
          })
        )}
      </div>

      <div className="max-h-[30%] overflow-auto border-b border-zinc-200 px-3 py-2">
        <LibraryFilters
          tabs={LIB_TABS}
          tab={libTab}
          onTabChange={(id) => setLibTab(id as LibTab)}
          filters={filters}
          onChange={setFilters}
          options={filterOptions}
          total={tabCount(selectedSummary, libTab, libraryTotal)}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <MediaList items={library} libTab={libTab} knownTags={filterOptions.tags} />
      </div>
    </aside>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="1.8">
      {dir === "left" ? <path d="M12.5 5 L7.5 10 L12.5 15" /> : <path d="M7.5 5 L12.5 10 L7.5 15" />}
    </svg>
  );
}
