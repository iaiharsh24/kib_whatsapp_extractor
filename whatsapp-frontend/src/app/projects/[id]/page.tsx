"use client";

import { useEffect, useState } from "react";
import { ReactFlowProvider, type Edge, type Node } from "@xyflow/react";
import { useParams } from "next/navigation";
import { api, fileSrc } from "@/lib/api";
import StrategyBoard from "@/components/canvas/StrategyBoard";
import ProjectChat from "@/components/ProjectChat";
import { MediaFrame, ItemMeta } from "@/components/MediaPreview";
import LibraryFilters, {
  EMPTY_LIBRARY_FILTERS,
  librarySearchParams,
} from "@/components/LibraryFilters";
import { TAGS_EVENT, uniqueTags } from "@/lib/tags";
import { getPreference, loadPreferences, savePreference } from "@/lib/preferences";
import { WORKSPACE_EVENT, getActiveWorkspaceId, loadWorkspaces, workspaceQuery } from "@/lib/workspace";
import type { LibraryFilterOptions, LibraryFilterState, LibraryResponse, MessageRecord, ProjectDetail, TagRecord } from "@/lib/types";

const LIB_TABS = [
  { id: "image", label: "Images" },
  { id: "reel", label: "Reels" },
  { id: "link", label: "Links" },
  { id: "all", label: "All" },
] as const;

export default function ProjectPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [library, setLibrary] = useState<MessageRecord[]>([]);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [libTab, setLibTab] = useState<(typeof LIB_TABS)[number]["id"]>("image");
  const [filters, setFilters] = useState<LibraryFilterState>(EMPTY_LIBRARY_FILTERS);
  const [filterOptions, setFilterOptions] = useState<LibraryFilterOptions>({
    senders: [],
    tags: [],
    chats: [],
    sites: [],
  });

  useEffect(() => {
    void loadPreferences().then(() => setLibraryOpen(getPreference("library_collapsed", false) !== true));
  }, []);

  useEffect(() => {
    void loadWorkspaces().catch(() => undefined);
  }, []);

  useEffect(() => {
    async function loadProject() {
      try {
        const project = await api<ProjectDetail>(`/api/projects/${projectId}`);
        setDetail(project);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load project");
      }
    }
    void loadProject();
  }, [projectId]);

  useEffect(() => {
    const workspaceId = getActiveWorkspaceId();
    if (!workspaceId) return;
    void api<LibraryFilterOptions>(`/api/library/filters?${workspaceQuery()}`)
      .then((data) => setFilterOptions((current) => ({ ...current, senders: data.senders, chats: data.chats, sites: data.sites })))
      .catch(() => undefined);
    void api<TagRecord[]>(`/api/workspaces/${workspaceId}/tags`)
      .then((rows) => setFilterOptions((current) => ({ ...current, tags: rows.map((row) => row.name) })))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    function onWorkspaceChange() {
      setLibrary([]);
      setLibraryTotal(0);
    }
    window.addEventListener(WORKSPACE_EVENT, onWorkspaceChange);
    return () => window.removeEventListener(WORKSPACE_EVENT, onWorkspaceChange);
  }, []);

  useEffect(() => {
    function onTags(event: Event) {
      const detail = (event as CustomEvent<{ messageId: string; tags: string[] }>).detail;
      if (!detail?.messageId) return;
      setLibrary((current) => current.map((item) => (item.id === detail.messageId ? { ...item, tags: detail.tags } : item)));
      setFilterOptions((current) => ({ ...current, tags: uniqueTags([...current.tags, ...detail.tags]) }));
    }
    window.addEventListener(TAGS_EVENT, onTags);
    return () => window.removeEventListener(TAGS_EVENT, onTags);
  }, []);

  useEffect(() => {
    async function loadLibrary() {
      const workspaceId = getActiveWorkspaceId();
      if (!workspaceId) return;
      const params = librarySearchParams(libTab, filters, { limit: "50" });
      params.set("workspace_id", workspaceId);
      const lib = await api<LibraryResponse>(`/api/library?${params.toString()}`);
      setLibrary(lib.items);
      setLibraryTotal(lib.total);
    }
    void loadLibrary().catch(() => undefined);
  }, [projectId, filters, libTab]);

  if (error) {
    return <div className="p-6 text-sm text-red-600">{error}</div>;
  }
  if (!detail) {
    return <div className="p-6 text-sm text-zinc-500">Loading project...</div>;
  }

  const initialNodes = (detail.canvas.nodes || []) as Node[];
  const initialEdges = (detail.canvas.edges || []) as Edge[];
  const initialFrames = (detail.canvas.frames || []) as Node[];
  const initialViewport = detail.canvas.viewport || null;

  return (
    <div className="flex h-full min-h-0">
      <aside
        className={`flex shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-white transition-[width] duration-200 ${
          libraryOpen ? "w-72" : "w-10"
        }`}
      >
        <button
          type="button"
          onClick={() => {
            setLibraryOpen((current) => {
              const next = !current;
              void savePreference("library_collapsed", !next);
              return next;
            });
          }}
          title={libraryOpen ? "Collapse library" : "Expand library"}
          className={`border-b border-zinc-200 text-left hover:bg-zinc-50 ${libraryOpen ? "px-3 py-3" : "px-0 py-3"}`}
        >
          {libraryOpen ? (
            <span className="flex items-start justify-between gap-2">
              <span>
                <h2 className="font-semibold">{detail.project.name}</h2>
                <p className="text-xs text-zinc-500">Drag items onto the canvas. No popups.</p>
              </span>
              <Chevron dir="left" />
            </span>
          ) : (
            <span className="flex justify-center text-zinc-500">
              <Chevron dir="right" />
            </span>
          )}
        </button>
        {libraryOpen ? (
          <>
            <div className="max-h-[45%] overflow-auto border-b border-zinc-200 px-3 py-2">
              <LibraryFilters
                tabs={LIB_TABS}
                tab={libTab}
                onTabChange={(id) => setLibTab(id as (typeof LIB_TABS)[number]["id"])}
                filters={filters}
                onChange={setFilters}
                options={filterOptions}
                total={libraryTotal}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {library.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-zinc-500">No items match these filters.</p>
              ) : libTab === "image" || libTab === "reel" ? (
                <div className="grid grid-cols-1 gap-2">
                  {library.map((item) => (
                    <div
                      key={item.id}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData("application/json", JSON.stringify(item));
                      }}
                      className="cursor-grab overflow-hidden rounded-lg ring-1 ring-zinc-200 hover:ring-emerald-500"
                    >
                      <MediaFrame item={item} kind={libTab} />
                      <ItemMeta item={item} editable knownTags={filterOptions.tags} />
                    </div>
                  ))}
                </div>
              ) : (
                library.map((item) => {
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
                        <ItemMeta item={item} editable knownTags={filterOptions.tags} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              setLibraryOpen(true);
              void savePreference("library_collapsed", false);
            }}
            className="flex flex-1 items-center justify-center text-[11px] uppercase tracking-wide text-zinc-500"
            title="Expand library"
          >
            <span className="rotate-90 whitespace-nowrap">Library</span>
          </button>
        )}
      </aside>
      <div className="relative h-full min-h-0 min-w-0 flex-1">
        <ReactFlowProvider>
          <StrategyBoard
            key={projectId}
            projectId={projectId}
            initialNodes={initialNodes}
            initialEdges={initialEdges}
            initialFrames={initialFrames}
            initialViewport={initialViewport}
          />
        </ReactFlowProvider>
      </div>
      <ProjectChat projectId={projectId} />
    </div>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="1.8">
      {dir === "left" ? <path d="M12.5 5 L7.5 10 L12.5 15" /> : <path d="M7.5 5 L12.5 10 L7.5 15" />}
    </svg>
  );
}
