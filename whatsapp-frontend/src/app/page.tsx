"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, fileSrc, formatWhen, getToken } from "@/lib/api";
import type { LibraryFilterOptions, LibraryResponse, MessageRecord, TagRecord, UploadRecord } from "@/lib/types";
import { InstagramReelEmbed, ItemMeta, MediaFrame, captionText, isInstagramEmbed } from "@/components/MediaPreview";
import { librarySearchParams } from "@/components/LibraryFilters";
import TagEditor from "@/components/TagEditor";
import { TAGS_EVENT, uniqueTags } from "@/lib/tags";
import { WORKSPACE_EVENT, getActiveWorkspaceId, loadWorkspaces, workspaceQuery } from "@/lib/workspace";

const TABS = [
  { id: "chat", label: "Chats" },
  { id: "link", label: "Links" },
  { id: "document", label: "Documents" },
  { id: "image", label: "Images" },
  { id: "reel", label: "Reels" },
] as const;

export default function LibraryPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("chat");
  const [items, setItems] = useState<MessageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<LibraryResponse["counts"]>();
  const [offset, setOffset] = useState(0);
  const [senders, setSenders] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [chats, setChats] = useState<string[]>([]);
  const [sites, setSites] = useState<string[]>([]);
  const [sender, setSender] = useState("");
  const [tag, setTag] = useState("");
  const [chat, setChat] = useState("");
  const [site, setSite] = useState("");
  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selected, setSelected] = useState<MessageRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("Uploading...");
  const [uploadBanner, setUploadBanner] = useState<{ id: string; added: number; skipped: number } | null>(null);
  const [uploadFilterId, setUploadFilterId] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (nextOffset = 0) => {
      const workspaceId = getActiveWorkspaceId();
      if (!workspaceId) return;
      const params = librarySearchParams(
        tab,
        { q, sender, chat, tag, site, dateFrom, dateTo },
        { offset: String(nextOffset), limit: "50" },
      );
      if (uploadFilterId) params.set("upload_id", uploadFilterId);
      params.set("workspace_id", workspaceId);
      const data = await api<LibraryResponse>(`/api/library?${params.toString()}`);
      setItems(data.items);
      setTotal(data.total);
      setOffset(data.offset);
      if (data.counts) setCounts(data.counts);
    },
    [tab, sender, chat, tag, site, q, dateFrom, dateTo, uploadFilterId],
  );

  useEffect(() => {
    void loadWorkspaces()
      .then(() => load(0))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, [load]);

  useEffect(() => {
    function onWorkspaceChange() {
      setUploadFilterId("");
      setUploadBanner(null);
      void load(0).catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
    }
    window.addEventListener(WORKSPACE_EVENT, onWorkspaceChange);
    return () => window.removeEventListener(WORKSPACE_EVENT, onWorkspaceChange);
  }, [load]);

  useEffect(() => {
    const workspaceId = getActiveWorkspaceId();
    if (!workspaceId) return;
    void api<LibraryFilterOptions>(`/api/library/filters?${workspaceQuery()}`)
      .then((data) => {
        setSenders(data.senders);
        setChats(data.chats || []);
        setSites(data.sites || []);
      })
      .catch(() => undefined);
    void api<TagRecord[]>(`/api/workspaces/${workspaceId}/tags`)
      .then((rows) => setTags(rows.map((row) => row.name)))
      .catch(() => undefined);
  }, [uploadFilterId]);

  useEffect(() => {
    function onTags(event: Event) {
      const detail = (event as CustomEvent<{ messageId: string; tags: string[] }>).detail;
      if (!detail?.messageId) return;
      setItems((current) => current.map((item) => (item.id === detail.messageId ? { ...item, tags: detail.tags } : item)));
      setSelected((current) => (current?.id === detail.messageId ? { ...current, tags: detail.tags } : current));
      setTags((current) => uniqueTags([...current, ...detail.tags]));
    }
    window.addEventListener(TAGS_EVENT, onTags);
    return () => window.removeEventListener(TAGS_EVENT, onTags);
  }, []);

  async function uploadFile(file: File) {
    const workspaceId = getActiveWorkspaceId();
    if (!workspaceId) {
      setError("Select or create a workspace before uploading.");
      return;
    }
    const form = new FormData();
    form.append("file", file);
    const isZip = file.name.toLowerCase().endsWith(".zip");
    setBusy(true);
    setBusyLabel(isZip ? "Extracting zip..." : "Uploading...");
    try {
      const uploadPath = `/api/uploads/file?workspace_id=${encodeURIComponent(workspaceId)}`;
      const created = await api<UploadRecord>(uploadPath, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken() || ""}` },
        body: form,
      });
      let finished: UploadRecord | null = null;
      for (let attempt = 0; attempt < 180; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        const current = await api<UploadRecord>(`/api/uploads/${created.id}`);
        if (current.status === "extracting") {
          setBusyLabel("Extracting zip...");
          continue;
        }
        if (current.status === "processing") {
          setBusyLabel("Parsing chat...");
          continue;
        }
        if (current.status === "completed") {
          finished = current;
          break;
        }
        if (current.status === "failed") {
          throw new Error(current.error_message || "Upload processing failed");
        }
      }
      if (finished) {
        setUploadBanner({
          id: finished.id,
          added: finished.message_count || 0,
          skipped: finished.duplicate_count || 0,
        });
        setUploadFilterId(finished.id);
      }
      await load(0);
      const filters = await api<LibraryFilterOptions>(`/api/library/filters?${workspaceQuery()}`);
      setSenders(filters.senders);
      setChats(filters.chats || []);
      setSites(filters.sites || []);
      if (workspaceId) {
        const registry = await api<TagRecord[]>(`/api/workspaces/${workspaceId}/tags`);
        setTags(registry.map((row) => row.name));
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-zinc-200 bg-white px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">Unified library</h2>
              <p className="text-sm text-zinc-500">{total} items in this tab · drag any row onto a project canvas</p>
            </div>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white"
            >
              {busy ? busyLabel : "Upload .txt or .zip"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.zip,application/zip"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadFile(file);
                event.target.value = "";
              }}
            />
          </div>
          {uploadBanner ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              <p>
                Added {uploadBanner.added} new items, skipped {uploadBanner.skipped} duplicates already in your library.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setUploadFilterId(uploadBanner.id);
                    void load(0);
                  }}
                  className="rounded-md bg-emerald-700 px-3 py-1.5 text-white"
                >
                  View new items
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUploadFilterId("");
                    setUploadBanner(null);
                    void load(0);
                  }}
                  className="rounded-md border border-emerald-300 px-3 py-1.5"
                >
                  Show all
                </button>
              </div>
            </div>
          ) : null}
          {uploadFilterId && !uploadBanner ? (
            <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm text-zinc-700">
              Showing items from the latest upload.{" "}
              <button
                type="button"
                onClick={() => {
                  setUploadFilterId("");
                  void load(0);
                }}
                className="text-emerald-700 underline"
              >
                Clear filter
              </button>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`rounded-full px-3 py-1 text-sm ${tab === item.id ? "bg-zinc-900 text-white" : "bg-zinc-100"}`}
              >
                {item.label}
                {counts ? ` (${counts[item.id] ?? 0})` : ""}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Keywords"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
            />
            <select
              value={sender}
              onChange={(event) => setSender(event.target.value)}
              className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
            >
              <option value="">All senders</option>
              {senders.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <select
              value={chat}
              onChange={(event) => setChat(event.target.value)}
              className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
            >
              <option value="">All chats</option>
              {chats.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <select
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
            >
              <option value="">All tags</option>
              {tags.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <select
              value={site}
              onChange={(event) => setSite(event.target.value)}
              className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
            >
              <option value="">All sites</option>
              {sites.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          </div>
        </header>
        {error ? <div className="bg-red-50 px-6 py-2 text-sm text-red-700">{error}</div> : null}
        <div className="flex-1 overflow-auto">
          {tab === "image" ? (
            <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {items.length === 0 ? (
                <p className="col-span-full py-8 text-center text-sm text-zinc-500">No images in this tab yet.</p>
              ) : (
                items.map((item) => (
                  <MediaCard
                    key={item.id}
                    item={item}
                    kind="image"
                    selected={selected?.id === item.id}
                    onSelect={() => setSelected(item)}
                    knownTags={tags}
                  />
                ))
              )}
            </div>
          ) : tab === "reel" ? (
            <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {items.length === 0 ? (
                <p className="col-span-full py-8 text-center text-sm text-zinc-500">No reels in this tab yet.</p>
              ) : (
                items.map((item) => (
                  <MediaCard
                    key={item.id}
                    item={item}
                    kind="reel"
                    selected={selected?.id === item.id}
                    onSelect={() => setSelected(item)}
                    knownTags={tags}
                  />
                ))
              )}
            </div>
          ) : tab === "link" ? (
            <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {items.length === 0 ? (
                <p className="col-span-full py-8 text-center text-sm text-zinc-500">No links in this tab yet.</p>
              ) : (
                items.map((item) => (
                  <LinkCard
                    key={item.id}
                    item={item}
                    selected={selected?.id === item.id}
                    onSelect={() => setSelected(item)}
                    knownTags={tags}
                  />
                ))
              )}
            </div>
          ) : (
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Sender</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Text / file</th>
                <th className="px-4 py-2">Tags</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                    No items in this tab yet.
                  </td>
                </tr>
              ) : (
              items.map((item) => (
                <tr
                  key={item.id}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/json", JSON.stringify(item));
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => setSelected(item)}
                  className="cursor-grab border-t border-zinc-100 bg-white hover:bg-emerald-50"
                >
                  <td className="whitespace-nowrap px-4 py-2 text-zinc-500">{formatWhen(item.timestamp)}</td>
                  <td className="px-4 py-2 font-medium">{item.sender}</td>
                  <td className="px-4 py-2 capitalize">{item.type.replace("_", " ")}</td>
                  <td className="max-w-xl px-4 py-2">
                    <div className="flex items-center gap-3">
                      {isImageItem(item) && fileSrc(item.extracted_url) ? (
                        <img
                          src={fileSrc(item.extracted_url) || ""}
                          alt=""
                          className="h-10 w-10 shrink-0 rounded object-cover bg-zinc-100"
                        />
                      ) : null}
                      <span className="truncate">
                        {item.extracted_filename || item.extracted_url || item.raw_text}
                      </span>
                    </div>
                  </td>
                  <td className="max-w-xs px-4 py-2">
                    <TagEditor tags={item.tags || []} knownTags={tags} messageId={item.id} />
                  </td>
                </tr>
              ))
              )}
            </tbody>
          </table>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-zinc-200 bg-white px-4 py-2 text-sm">
          <button type="button" disabled={offset === 0} onClick={() => void load(Math.max(0, offset - 50))} className="disabled:opacity-40">
            Previous
          </button>
          <span>
            {offset + 1}-{Math.min(offset + items.length, total)} of {total}
          </span>
          <button
            type="button"
            disabled={offset + items.length >= total}
            onClick={() => void load(offset + 50)}
            className="disabled:opacity-40"
          >
            Next 50
          </button>
        </div>
      </div>
      {selected ? (
        <aside className="w-[360px] overflow-auto border-l border-zinc-200 bg-white p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs uppercase text-emerald-700">{selected.type}</p>
              <h3 className="font-semibold">{selected.sender}</h3>
              <p className="text-xs text-zinc-500">{formatWhen(selected.timestamp)}</p>
            </div>
            <button type="button" onClick={() => setSelected(null)} className="text-sm text-zinc-500">
              Close
            </button>
          </div>
          {selected.context_before ? (
            <p className="mt-4 text-xs text-zinc-400">Before: {selected.context_before}</p>
          ) : null}
          <p className="mt-3 whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-sm">{selected.raw_text}</p>
          {selected.context_after ? (
            <p className="mt-3 text-xs text-zinc-400">After: {selected.context_after}</p>
          ) : null}
          <div className="mt-3 rounded-lg border border-zinc-200 px-2 py-1.5">
            <TagEditor tags={selected.tags || []} knownTags={tags} messageId={selected.id} />
          </div>
          {selected.extracted_filename || selected.extracted_url || selected.link_preview || isImageItem(selected) || selected.type === "reel" ? (
            <FilePreview item={selected} />
          ) : null}
          <p className="mt-4 text-xs text-zinc-500">Drag this row onto a project canvas to pin it.</p>
        </aside>
      ) : null}
    </div>
  );
}

function isImageItem(item: MessageRecord): boolean {
  const name = (item.extracted_filename || item.extracted_url || "").toLowerCase();
  return item.type === "image" || item.type === "media_omitted" || /\.(jpg|jpeg|png|gif|webp)$/i.test(name);
}

function isHttpUrl(value?: string | null): boolean {
  return !!value && /^https?:\/\//i.test(value);
}

function isFavicon(image?: string | null): boolean {
  return !!image && image.includes("google.com/s2/favicons");
}

function previewSrc(image?: string | null, proxied = false): string {
  if (!image) return "";
  if (proxied) return `/api/previews/image?url=${encodeURIComponent(image)}`;
  return image;
}

const SITE_THEME: Record<string, string> = {
  YouTube: "bg-red-600 text-white",
  Instagram: "bg-gradient-to-br from-purple-600 via-pink-500 to-orange-400 text-white",
  GitHub: "bg-zinc-900 text-white",
  "Google Drive": "bg-amber-400 text-zinc-900",
  "Google Docs": "bg-blue-600 text-white",
  "Google Meet": "bg-green-600 text-white",
  "Chrome Web Store": "bg-sky-600 text-white",
  "Adobe Acrobat": "bg-red-700 text-white",
  Facebook: "bg-blue-700 text-white",
  Notion: "bg-zinc-800 text-white",
};

function PreviewThumb({
  preview,
  className = "h-36",
}: {
  preview?: MessageRecord["link_preview"] | null;
  className?: string;
}) {
  const [proxied, setProxied] = useState(false);
  const [failed, setFailed] = useState(false);
  const image = preview?.image;
  useEffect(() => {
    setProxied(false);
    setFailed(false);
  }, [image]);
  const theme = SITE_THEME[preview?.site || ""] || "bg-zinc-800 text-white";
  if (!image || isFavicon(image) || failed) {
    return (
      <div className={`flex ${className} w-full items-center justify-center px-4 text-center ${theme}`}>
        <div>
          <p className="text-[10px] uppercase tracking-wide opacity-80">{preview?.site || "Link"}</p>
          <p className="mt-1 line-clamp-2 text-sm font-semibold">{preview?.title || preview?.domain || "Open link"}</p>
        </div>
      </div>
    );
  }
  return (
    <img
      src={previewSrc(image, proxied)}
      alt=""
      className={`${className} w-full bg-zinc-100 object-cover`}
      onError={() => {
        if (!proxied) setProxied(true);
        else setFailed(true);
      }}
    />
  );
}

function isLocalPath(value?: string | null): boolean {
  return !!value && value.startsWith("/api/files/");
}

function MediaCard({
  item,
  kind,
  selected,
  onSelect,
  knownTags = [],
}: {
  item: MessageRecord;
  kind: "image" | "reel";
  selected?: boolean;
  onSelect: () => void;
  knownTags?: string[];
}) {
  const [preview, setPreview] = useState(item.link_preview || null);
  const local = isLocalPath(item.extracted_url) ? fileSrc(item.extracted_url) : null;
  const href = preview?.url || (isHttpUrl(item.extracted_url) ? item.extracted_url : "") || item.urls?.[0] || "";

  useEffect(() => {
    setPreview(item.link_preview || null);
    if (!href || !isHttpUrl(href) || local) return;
    if (item.link_preview?.embed) return;
    void api<NonNullable<MessageRecord["link_preview"]>>(`/api/previews?url=${encodeURIComponent(href)}`)
      .then((data) => setPreview((current) => ({ ...(current || { url: href }), ...data })))
      .catch(() => undefined);
  }, [href, item.id, item.link_preview, local]);

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("application/json", JSON.stringify({ ...item, link_preview: preview }));
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onSelect}
      className={`group cursor-grab overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-zinc-200 hover:ring-emerald-500 ${
        selected ? "ring-2 ring-emerald-600" : ""
      }`}
    >
      <MediaFrame item={{ ...item, link_preview: preview }} kind={kind} />
      <ItemMeta item={item} editable knownTags={knownTags} />
    </div>
  );
}

function LinkCard({
  item,
  selected,
  onSelect,
  knownTags = [],
}: {
  item: MessageRecord;
  selected?: boolean;
  onSelect: () => void;
  knownTags?: string[];
}) {
  const [preview, setPreview] = useState(item.link_preview || null);
  const extraUrls = (item.urls || preview?.urls || []).filter(
    (url, index, all) => isHttpUrl(url) && all.indexOf(url) === index && url !== (preview?.url || item.extracted_url),
  );
  const href = preview?.url || (isHttpUrl(item.extracted_url) ? item.extracted_url : "") || item.urls?.[0] || "";
  const caption = captionText(item);
  const localMedia = fileSrc(item.extracted_url);
  const isLocalVideo = !!localMedia && !isHttpUrl(item.extracted_url) && /\.(mp4|webm|mov)$/i.test(item.extracted_filename || item.extracted_url || "");
  const isLocalImage = !!localMedia && !isHttpUrl(item.extracted_url) && isImageItem(item);

  useEffect(() => {
    setPreview(item.link_preview || null);
    if (!href || !isHttpUrl(href)) return;
    const title = item.link_preview?.title || "";
    const weak = !title || title === item.link_preview?.domain || title === item.link_preview?.site || title === "Chrome extension";
    if (item.link_preview?.fetched && !weak) return;
    void api<NonNullable<MessageRecord["link_preview"]>>(`/api/previews?url=${encodeURIComponent(href)}`)
      .then((data) => setPreview((current) => ({ ...(current || { url: href }), ...data, urls: current?.urls || item.urls })))
      .catch(() => undefined);
  }, [href, item.id, item.link_preview, item.urls]);

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("application/json", JSON.stringify({ ...item, link_preview: preview }));
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onSelect}
      className={`cursor-grab overflow-hidden rounded-xl border bg-white shadow-sm hover:border-emerald-500 ${
        selected ? "border-emerald-600" : "border-zinc-200"
      }`}
    >
      {isLocalVideo ? (
        <video src={localMedia || ""} className="h-36 w-full bg-black object-contain" muted />
      ) : isLocalImage ? (
        <img src={localMedia || ""} alt="" className="h-36 w-full bg-zinc-100 object-contain" />
      ) : (
        <PreviewThumb preview={preview} />
      )}
      <div className="space-y-1 p-3">
        <p className="text-[10px] uppercase text-emerald-700">{preview?.site || item.type}</p>
        <p className="line-clamp-2 text-sm font-semibold">{preview?.title || item.extracted_filename || href || item.raw_text}</p>
        {caption ? <p className="line-clamp-3 text-xs text-zinc-600">{caption}</p> : null}
        {preview?.description ? <p className="line-clamp-2 text-xs text-zinc-500">{preview.description}</p> : null}
        {href ? <p className="truncate text-xs text-emerald-800">{href}</p> : null}
        {extraUrls.map((url) => (
          <p key={url} className="truncate text-[11px] text-zinc-500">
            {url}
          </p>
        ))}
        <p className="text-[11px] font-medium text-zinc-800">{item.sender}</p>
        <p className="text-[11px] text-zinc-400">{formatWhen(item.timestamp)}</p>
        <TagEditor tags={item.tags || []} knownTags={knownTags} messageId={item.id} />
      </div>
    </div>
  );
}

function FilePreview({ item }: { item: MessageRecord }) {
  const [preview, setPreview] = useState(item.link_preview || null);
  const href = fileSrc(item.extracted_url) || item.extracted_url || preview?.url;
  const name = (item.extracted_filename || item.extracted_url || "file").toLowerCase();
  const isImage = item.type === "image" || /\.(jpg|jpeg|png|gif|webp)$/i.test(name);
  const isVideo = /\.(mp4|webm|mov)$/i.test(name) || item.type === "reel";
  const http = isHttpUrl(item.extracted_url) || isHttpUrl(preview?.url);
  const local = isLocalPath(item.extracted_url);
  const urls = (preview?.urls?.length ? preview.urls : item.urls || (http && item.extracted_url ? [item.extracted_url] : [])).filter(
    (url, index, all) => all.indexOf(url) === index,
  );

  useEffect(() => {
    setPreview(item.link_preview || null);
    const first = item.link_preview?.url || (isHttpUrl(item.extracted_url) ? item.extracted_url : null) || item.urls?.[0];
    if (!first || !isHttpUrl(first) || item.link_preview?.fetched) return;
    void api<NonNullable<MessageRecord["link_preview"]>>(`/api/previews?url=${encodeURIComponent(first)}`)
      .then((data) => setPreview((current) => ({ ...(current || { url: first }), ...data })))
      .catch(() => undefined);
  }, [item]);

  return (
    <div className="mt-3 space-y-3">
      {item.extracted_filename ? <p className="text-xs text-zinc-500">{item.extracted_filename}</p> : null}
      {href && isImage && local ? (
        <div className="overflow-hidden rounded-xl bg-black">
          <div className="relative aspect-[4/5] w-full">
            <img src={href} alt={item.extracted_filename || "media"} className="h-full w-full object-contain" />
          </div>
        </div>
      ) : null}
      {href && isVideo && local ? (
        <div className="overflow-hidden rounded-xl bg-black">
          <div className="relative mx-auto aspect-[9/16] w-full max-w-[260px]">
            <video src={href} controls playsInline className="h-full w-full object-contain" />
          </div>
        </div>
      ) : null}
      {preview?.embed && !local && (isInstagramEmbed(preview.embed) || isInstagramEmbed(preview.url)) ? (
        <div className="overflow-hidden rounded-xl bg-black">
          <div className="relative mx-auto aspect-[9/16] w-full max-w-[280px] overflow-hidden">
            <InstagramReelEmbed src={preview.embed || preview.url} interactive />
          </div>
        </div>
      ) : preview?.embed && !local && !isInstagramEmbed(preview.embed) ? (
        <div className="overflow-hidden rounded-xl bg-black">
          <div className={`relative w-full ${item.type === "reel" || preview.kind === "video" ? "aspect-[9/16]" : "aspect-video"}`}>
            <iframe
              title={preview.title || "preview"}
              src={preview.embed}
              className="absolute inset-0 h-full w-full border-0"
              allow="accelerometer; autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          </div>
        </div>
      ) : preview?.image && http && !local ? (
        <a href={preview.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-zinc-200">
          <PreviewThumb preview={preview} className="h-40" />
        </a>
      ) : null}
      {preview?.title && !isInstagramEmbed(preview.embed || preview.url) ? <p className="text-sm font-medium">{preview.title}</p> : null}
      {preview?.description && !isInstagramEmbed(preview.embed || preview.url) ? <p className="text-xs text-zinc-500">{preview.description}</p> : null}
      {urls.map((url) => (
        <a key={url} href={url} target="_blank" rel="noreferrer" className="block truncate text-sm text-emerald-700 underline">
          {url}
        </a>
      ))}
      {href && local ? (
        <a href={href} target="_blank" rel="noreferrer" className="block text-sm text-emerald-700 underline">
          Open file
        </a>
      ) : null}
    </div>
  );
}
