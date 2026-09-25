import { useState, useMemo, useEffect, useRef } from "react";
import { X, Search, Inbox, MessageSquare, ChevronDown } from "lucide-react";
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

// Parse a user-entered duration into seconds. Accepts "Never", the human
// format ("1d 2h 30m") and the TimeSpan format ("00:01:00", "7.00:00:00").
// Returns null when the input cannot be understood, Infinity for "Never".
export function durationToSeconds(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "never") return Infinity;

  const timeSpan = trimmed.match(
    /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/,
  );
  if (timeSpan) {
    const days = parseInt(timeSpan[1] ?? "0");
    if (days >= MAX_TIMESPAN_DAYS) return Infinity;
    return (
      days * 86400 +
      parseInt(timeSpan[2]) * 3600 +
      parseInt(timeSpan[3]) * 60 +
      parseInt(timeSpan[4])
    );
  }

  // Human format - every character must belong to a "<number><unit>" token
  if (trimmed.replace(/\d+\s*[dhms]/gi, "").trim() !== "") return null;
  let totalSeconds = 0;
  const pattern = /(\d+)\s*([dhms])/gi;
  let match;
  while ((match = pattern.exec(trimmed)) !== null) {
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === "d") totalSeconds += value * 86400;
    else if (unit === "h") totalSeconds += value * 3600;
    else if (unit === "m") totalSeconds += value * 60;
    else totalSeconds += value;
  }
  if (totalSeconds >= MAX_TIMESPAN_DAYS * 86400) return Infinity;
  return totalSeconds;
}

function describeSeconds(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export interface DurationPreset {
  label: string;
  value: string;
}

export interface DurationFieldConfig {
  presets: DurationPreset[];
  placeholder: string;
  allowNever?: boolean;
  minSeconds?: number;
  maxSeconds?: number;
}

// Service Bus limits, see
// https://learn.microsoft.com/azure/service-bus-messaging/service-bus-quotas
export const TTL_FIELD: DurationFieldConfig = {
  placeholder: "e.g. 14d or 1h 30m",
  allowNever: true,
  minSeconds: 1,
  presets: [
    { label: "Never (default)", value: "Never" },
    { label: "5 minutes", value: "5m" },
    { label: "1 hour", value: "1h" },
    { label: "1 day", value: "1d" },
    { label: "7 days", value: "7d" },
    { label: "14 days", value: "14d" },
    { label: "30 days", value: "30d" },
  ],
};

export const AUTO_DELETE_FIELD: DurationFieldConfig = {
  placeholder: "e.g. Never or 7d",
  allowNever: true,
  minSeconds: 300,
  presets: [
    { label: "Never (default)", value: "Never" },
    { label: "5 minutes (minimum)", value: "5m" },
    { label: "1 hour", value: "1h" },
    { label: "1 day", value: "1d" },
    { label: "7 days", value: "7d" },
    { label: "30 days", value: "30d" },
  ],
};

export const LOCK_DURATION_FIELD: DurationFieldConfig = {
  placeholder: "e.g. 30s or 1m",
  minSeconds: 5,
  maxSeconds: 300,
  presets: [
    { label: "5 seconds (minimum)", value: "5s" },
    { label: "15 seconds", value: "15s" },
    { label: "30 seconds", value: "30s" },
    { label: "1 minute (default)", value: "1m" },
    { label: "2 minutes", value: "2m" },
    { label: "5 minutes (maximum)", value: "5m" },
  ],
};

export const DUPLICATE_DETECTION_FIELD: DurationFieldConfig = {
  placeholder: "e.g. 10m",
  minSeconds: 20,
  maxSeconds: 7 * 86400,
  presets: [
    { label: "20 seconds (minimum)", value: "20s" },
    { label: "1 minute", value: "1m" },
    { label: "10 minutes (default)", value: "10m" },
    { label: "1 hour", value: "1h" },
    { label: "1 day", value: "1d" },
    { label: "7 days (maximum)", value: "7d" },
  ],
};

// Returns an error message when the value can't be used, null when it's fine
export function validateDuration(
  value: string,
  config: DurationFieldConfig,
): string | null {
  const seconds = durationToSeconds(value);
  if (seconds === null) {
    return "Use a duration like 30s, 5m, 1h or 7d";
  }
  if (seconds === Infinity) {
    return config.allowNever ? null : "Must be a finite duration";
  }
  if (config.minSeconds !== undefined && seconds < config.minSeconds) {
    return `Must be at least ${describeSeconds(config.minSeconds)}`;
  }
  if (config.maxSeconds !== undefined && seconds > config.maxSeconds) {
    return `Must be at most ${describeSeconds(config.maxSeconds)}`;
  }
  return null;
}

interface DurationInputProps extends DurationFieldConfig {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputClassName?: string;
}

// Free-text duration field with a dropdown of common values
export function DurationInput({
  label,
  value,
  onChange,
  presets,
  placeholder,
  allowNever,
  minSeconds,
  maxSeconds,
  inputClassName = "w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded text-white text-sm",
}: DurationInputProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  const error = validateDuration(value, {
    presets,
    placeholder,
    allowNever,
    minSeconds,
    maxSeconds,
  });
  const timeSpan =
    !error && value.trim().toLowerCase() !== "never"
      ? formatDuration(value)
      : null;

  return (
    <div className="relative" ref={containerRef}>
      <label className="block text-sm text-dark-400 mb-1">{label}</label>
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputClassName} pr-9 ${error ? "border-red-500/60" : ""}`}
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="absolute right-0 top-0 h-full px-2 text-dark-400 hover:text-white"
          title="Common values"
          aria-label={`${label} suggestions`}
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      </div>
      {error ? (
        <p className="mt-1 text-xs text-red-400">{error}</p>
      ) : (
        timeSpan && <p className="mt-1 text-xs text-dark-500">{timeSpan}</p>
      )}
      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-dark-800 border border-dark-600 rounded-lg shadow-xl max-h-56 overflow-y-auto">
          {presets.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => {
                onChange(preset.value);
                setIsOpen(false);
              }}
              className="w-full px-3 py-2 text-left text-sm text-white hover:bg-dark-700 flex items-center justify-between gap-2"
            >
              <span>{preset.label}</span>
              <span className="text-dark-500 text-xs">{preset.value}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
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
