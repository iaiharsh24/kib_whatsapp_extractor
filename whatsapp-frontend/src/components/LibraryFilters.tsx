"use client";

import { useMemo, useState } from "react";
import type { LibraryFilterOptions, LibraryFilterState } from "@/lib/types";

export const EMPTY_LIBRARY_FILTERS: LibraryFilterState = {
  q: "",
  sender: "",
  chat: "",
  tag: "",
  site: "",
  dateFrom: "",
  dateTo: "",
};

type FilterKey = keyof LibraryFilterState;

const LEVELS: {
  key: Exclude<FilterKey, "q">;
  label: string;
  empty: string;
  optionsKey?: keyof LibraryFilterOptions;
  kind: "select" | "date";
}[] = [
  { key: "sender", label: "Sender", empty: "All senders", optionsKey: "senders", kind: "select" },
  { key: "chat", label: "Chat", empty: "All chats", optionsKey: "chats", kind: "select" },
  { key: "tag", label: "Tag", empty: "All tags", optionsKey: "tags", kind: "select" },
  { key: "site", label: "Site", empty: "All sites", optionsKey: "sites", kind: "select" },
  { key: "dateFrom", label: "From", empty: "Any start", kind: "date" },
  { key: "dateTo", label: "To", empty: "Any end", kind: "date" },
];

export function librarySearchParams(
  tab: string,
  filters: LibraryFilterState,
  extra?: Record<string, string>,
): URLSearchParams {
  const params = new URLSearchParams({ tab, ...(extra || {}) });
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.sender) params.set("sender", filters.sender);
  if (filters.chat) params.set("chat", filters.chat);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.site) params.set("site", filters.site);
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  return params;
}

function formatChip(key: Exclude<FilterKey, "q">, value: string): string {
  const level = LEVELS.find((item) => item.key === key);
  if (key === "dateFrom") return `From ${value}`;
  if (key === "dateTo") return `To ${value}`;
  return `${level?.label || key}: ${value}`;
}

export default function LibraryFilters({
  tabs,
  tab,
  onTabChange,
  filters,
  onChange,
  options,
  total,
}: {
  tabs: readonly { id: string; label: string }[];
  tab: string;
  onTabChange: (id: string) => void;
  filters: LibraryFilterState;
  onChange: (next: LibraryFilterState) => void;
  options: LibraryFilterOptions;
  total?: number;
}) {
  const [openKeys, setOpenKeys] = useState<Exclude<FilterKey, "q">[]>([]);
  const visibleKeys = useMemo(() => {
    const active = LEVELS.map((item) => item.key).filter((key) => filters[key]);
    return Array.from(new Set([...openKeys, ...active]));
  }, [filters, openKeys]);
  const unused = LEVELS.filter((item) => !visibleKeys.includes(item.key));
  const activeCount = LEVELS.filter((item) => filters[item.key]).length + (filters.q.trim() ? 1 : 0);

  function setField(key: FilterKey, value: string) {
    onChange({ ...filters, [key]: value });
  }

  function removeLevel(key: Exclude<FilterKey, "q">) {
    setOpenKeys((current) => current.filter((item) => item !== key));
    setField(key, "");
  }

  function clearAll() {
    setOpenKeys([]);
    onChange({ ...EMPTY_LIBRARY_FILTERS });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onTabChange(item.id)}
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              tab === item.id ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {visibleKeys.map((key) => {
        const level = LEVELS.find((item) => item.key === key);
        if (!level) return null;
        const choices = level.optionsKey ? options[level.optionsKey] : [];
        return (
          <div key={key} className="flex items-center gap-1">
            <label className="w-12 shrink-0 text-[10px] uppercase tracking-wide text-zinc-500">{level.label}</label>
            {level.kind === "select" ? (
              <select
                value={filters[key]}
                onChange={(event) => setField(key, event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-1.5 py-1 text-xs"
              >
                <option value="">{level.empty}</option>
                {choices.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="date"
                value={filters[key]}
                onChange={(event) => setField(key, event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-zinc-300 px-1.5 py-1 text-xs"
              />
            )}
            <button
              type="button"
              onClick={() => removeLevel(key)}
              className="shrink-0 rounded px-1 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              title={`Remove ${level.label} filter`}
            >
              ×
            </button>
          </div>
        );
      })}

      {unused.length > 0 ? (
        <select
          value=""
          onChange={(event) => {
            const key = event.target.value as Exclude<FilterKey, "q">;
            if (!key) return;
            setOpenKeys((current) => (current.includes(key) ? current : [...current, key]));
          }}
          className="w-full rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-1.5 py-1 text-xs text-zinc-600"
        >
          <option value="">Add filter</option>
          {unused.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      ) : null}

      <input
        value={filters.q}
        onChange={(event) => setField("q", event.target.value)}
        placeholder="Search library"
        className="w-full rounded-md border border-zinc-300 px-2 py-1 text-xs"
      />

      {activeCount > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {filters.q.trim() ? (
            <button
              type="button"
              onClick={() => setField("q", "")}
              className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600 hover:bg-zinc-200"
            >
              Search: {filters.q.trim()} ×
            </button>
          ) : null}
          {LEVELS.filter((item) => filters[item.key]).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => removeLevel(item.key)}
              className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600 hover:bg-zinc-200"
            >
              {formatChip(item.key, filters[item.key])} ×
            </button>
          ))}
          <button type="button" onClick={clearAll} className="text-[10px] text-emerald-700 hover:underline">
            Clear all
          </button>
          {typeof total === "number" ? <span className="ml-auto text-[10px] text-zinc-400">{total} items</span> : null}
        </div>
      ) : typeof total === "number" ? (
        <p className="text-[10px] text-zinc-400">{total} items</p>
      ) : null}
    </div>
  );
}
