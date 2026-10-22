import { useState } from 'react';
import { formatDateTime, useDateFormat } from '../utils/dateFormat';

interface DateTimeTextProps {
  value: string | Date;
  className?: string;
}

/**
 * A timestamp shown in the user's local timezone; clicking it toggles to UTC and back.
 * The click is not propagated so it doesn't also trigger an enclosing row's handler.
 */
export default function DateTimeText({ value, className }: DateTimeTextProps) {
  const format = useDateFormat();
  // Remember which value was toggled so a reused instance (e.g. a different message) starts in local time.
  const valueKey = value instanceof Date ? value.getTime().toString() : value;
  const [utcFor, setUtcFor] = useState<string | null>(null);
  const utc = utcFor === valueKey;

  const toggle = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setUtcFor(utc ? null : valueKey);
  };

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={toggle}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') toggle(e);
      }}
      title={utc ? 'Showing UTC — click for local time' : 'Showing local time — click for UTC'}
      className={`cursor-pointer hover:underline decoration-dotted underline-offset-2 ${className ?? ''}`}
    >
      {formatDateTime(value, format, utc)}
    </span>
  );
}
