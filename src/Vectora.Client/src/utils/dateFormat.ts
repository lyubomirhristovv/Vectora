import { useSyncExternalStore } from 'react';

// User-selected date format for all timestamps rendered in the app.
// Purely a client-side display preference, so it lives in localStorage
// (per-browser, per-user) rather than the shared backend Settings table.

const STORAGE_KEY = 'vectora_date_format';

/** 'system' = browser locale via toLocaleString(); anything else is a token pattern. */
export const SYSTEM_FORMAT = 'system';

export const DATE_FORMATS: { id: string; label: string }[] = [
  { id: SYSTEM_FORMAT, label: 'System default' },
  { id: 'dd/MM/yyyy HH:mm:ss', label: 'dd/MM/yyyy HH:mm:ss' },
  { id: 'dd.MM.yyyy HH:mm:ss', label: 'dd.MM.yyyy HH:mm:ss' },
  { id: 'MM/dd/yyyy hh:mm:ss a', label: 'MM/dd/yyyy hh:mm:ss AM/PM' },
  { id: 'yyyy-MM-dd HH:mm:ss', label: 'yyyy-MM-dd HH:mm:ss' },
  { id: 'dd MMM yyyy HH:mm:ss', label: 'dd MMM yyyy HH:mm:ss' },
];

let currentFormat = readStoredFormat();
const listeners = new Set<() => void>();

function readStoredFormat(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored && DATE_FORMATS.some(f => f.id === stored) ? stored : SYSTEM_FORMAT;
}

export function getDateFormat(): string {
  return currentFormat;
}

export function setDateFormat(format: string) {
  currentFormat = DATE_FORMATS.some(f => f.id === format) ? format : SYSTEM_FORMAT;
  localStorage.setItem(STORAGE_KEY, currentFormat);
  listeners.forEach(l => l());
}

/** Subscribes the component to format changes so displayed dates update immediately. */
export function useDateFormat(): string {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => currentFormat
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatWithPattern(d: Date, pattern: string, utc = false): string {
  const year = utc ? d.getUTCFullYear() : d.getFullYear();
  const month = utc ? d.getUTCMonth() : d.getMonth();
  const day = utc ? d.getUTCDate() : d.getDate();
  const hours24 = utc ? d.getUTCHours() : d.getHours();
  const minutes = utc ? d.getUTCMinutes() : d.getMinutes();
  const seconds = utc ? d.getUTCSeconds() : d.getSeconds();
  const hours12 = hours24 % 12 || 12;
  return pattern.replace(/yyyy|MMM|MM|dd|HH|hh|mm|ss|a/g, token => {
    switch (token) {
      case 'yyyy': return year.toString();
      case 'MMM': return MONTHS[month];
      case 'MM': return pad2(month + 1);
      case 'dd': return pad2(day);
      case 'HH': return pad2(hours24);
      case 'hh': return pad2(hours12);
      case 'mm': return pad2(minutes);
      case 'ss': return pad2(seconds);
      case 'a': return hours24 < 12 ? 'AM' : 'PM';
      default: return token;
    }
  });
}

/**
 * Formats a timestamp with the user's chosen format (defaults to the stored preference).
 * Renders in the browser's local timezone unless `utc` is set, in which case the
 * UTC wall-clock time is shown with a " UTC" suffix.
 * Components should call useDateFormat() so they re-render when the preference changes.
 */
export function formatDateTime(value: string | Date, format?: string, utc = false): string {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value);
  const fmt = format ?? currentFormat;
  if (!utc) return fmt === SYSTEM_FORMAT ? d.toLocaleString() : formatWithPattern(d, fmt);
  const text = fmt === SYSTEM_FORMAT ? d.toLocaleString(undefined, { timeZone: 'UTC' }) : formatWithPattern(d, fmt, true);
  return `${text} UTC`;
}

/** Strips time tokens from a date-time pattern, leaving only the date portion. */
function getDateOnlyPattern(pattern: string): string {
  return pattern.replace(/\s*(?:HH|hh):mm:ss(?:\s+a)?/g, '').trim();
}

/**
 * Formats a date (date portion only, no time) using the user's chosen format.
 * Components should call useDateFormat() so they re-render when the preference changes.
 */
export function formatDate(value: string | Date, format?: string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value);
  const fmt = format ?? currentFormat;
  return fmt === SYSTEM_FORMAT ? d.toLocaleDateString() : formatWithPattern(d, getDateOnlyPattern(fmt));
}
