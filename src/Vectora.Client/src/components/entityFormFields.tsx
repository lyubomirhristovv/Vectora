import { useState, useMemo } from "react";
import { X, Search, Inbox, MessageSquare } from "lucide-react";
import type { QueueInfo, TopicInfo } from "../types";

// TimeSpan.MaxValue in days (approximately 10675199 days)
export const MAX_TIMESPAN_DAYS = 10675199;

// Parse ISO 8601 duration to human-readable format
export function parseDuration(iso: string): string {
  const match = iso.match(/^(\d+)\.(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (match) {
    const [, days, hours, minutes, seconds] = match;
    const daysNum = parseInt(days);
    // Detect TimeSpan.MaxValue (never expires)
    if (daysNum >= MAX_TIMESPAN_DAYS) {
      return "Never";
    }
    const parts: string[] = [];
    if (daysNum > 0) parts.push(`${daysNum}d`);
    if (hours !== "00") parts.push(`${parseInt(hours)}h`);
    if (minutes !== "00") parts.push(`${parseInt(minutes)}m`);
    if (seconds !== "00") parts.push(`${parseInt(seconds)}s`);
    return parts.length > 0 ? parts.join(" ") : "0s";
  }
  return iso;
}

// Format duration for API (TimeSpan format: d.hh:mm:ss)
export function formatDuration(input: string): string {
  // Handle "Never" - return TimeSpan.MaxValue
  if (input.toLowerCase() === "never") {
    return `${MAX_TIMESPAN_DAYS}.00:00:00`;
  }
  // Try to parse human format like "14d" or "5m" or "1d 2h 30m"
  let totalSeconds = 0;
  const pattern = /(\d+)\s*(d|h|m|s)/gi;
  let match;
  while ((match = pattern.exec(input)) !== null) {
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === "d") totalSeconds += value * 86400;
    else if (unit === "h") totalSeconds += value * 3600;
    else if (unit === "m") totalSeconds += value * 60;
    else if (unit === "s") totalSeconds += value;
  }
  if (totalSeconds > 0) {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${days}.${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  // Already in correct format or not parseable
  return input;
}

interface ForwardToSelectorProps {
  value: string;
  onChange: (value: string) => void;
  queues: QueueInfo[];
  topics: TopicInfo[];
  label: string;
}

export function ForwardToSelector({
  value,
  onChange,
  queues,
  topics,
  label,
}: ForwardToSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");

  const allEntities = useMemo(() => {
    const entities: { type: "queue" | "topic"; name: string }[] = [];
    queues.forEach((q) => entities.push({ type: "queue", name: q.name }));
    topics.forEach((t) => entities.push({ type: "topic", name: t.name }));
    return entities;
  }, [queues, topics]);

  const filtered = useMemo(() => {
    if (!search) return allEntities;
    const lower = search.toLowerCase();
    return allEntities.filter((e) => e.name.toLowerCase().includes(lower));
  }, [allEntities, search]);

  return (
    <div className="relative">
      <label className="block text-sm text-dark-400 mb-1">{label}</label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex-1 px-3 py-2 bg-dark-700 border border-dark-600 rounded text-white text-sm text-left flex items-center gap-2"
        >
          {value ? (
            <>
              {allEntities.find((e) => e.name === value)?.type === "queue" ? (
                <Inbox className="w-4 h-4 text-primary-400" />
              ) : (
                <MessageSquare className="w-4 h-4 text-primary-400" />
              )}
              <span className="truncate">{value}</span>
            </>
          ) : (
            <span className="text-dark-500">None</span>
          )}
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="px-2 py-2 bg-dark-700 border border-dark-600 rounded text-dark-400 hover:text-white"
            title="Clear"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-dark-800 border border-dark-600 rounded-lg shadow-xl max-h-64 overflow-hidden">
          <div className="p-2 border-b border-dark-600">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-500" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full pl-8 pr-3 py-1.5 bg-dark-700 border border-dark-600 rounded text-sm text-white placeholder-dark-500"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-dark-500 text-sm">
                No entities found
              </div>
            ) : (
              filtered.map((entity) => (
                <button
                  key={`${entity.type}-${entity.name}`}
                  type="button"
                  onClick={() => {
                    onChange(entity.name);
                    setIsOpen(false);
                    setSearch("");
                  }}
                  className="w-full px-3 py-2 text-left text-sm text-white hover:bg-dark-700 flex items-center gap-2"
                >
                  {entity.type === "queue" ? (
                    <Inbox className="w-4 h-4 text-primary-400" />
                  ) : (
                    <MessageSquare className="w-4 h-4 text-primary-400" />
                  )}
                  <span className="truncate">{entity.name}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
