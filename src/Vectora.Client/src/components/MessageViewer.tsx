import { useMemo, useState } from 'react';
import { Copy, Check, FileJson, Code, FileInput } from 'lucide-react';
import Editor from '@monaco-editor/react';
import type { ServiceBusMessage } from '../types';
import DateTimeText from './DateTimeText';

export type ViewMode = 'body' | 'properties';

// Dead-letter details arrive as application properties too; we surface them in their own
// section, so filter them out of the generic Application Properties list to avoid duplication.
const DLQ_PROPERTY_KEYS = new Set(['DeadLetterReason', 'DeadLetterErrorDescription', 'DeadLetterSource']);

interface MessageViewerProps {
  message: ServiceBusMessage;
  onUseAsTemplate?: (message: ServiceBusMessage) => void;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
}

export default function MessageViewer({ message, onUseAsTemplate, viewMode: controlledViewMode, onViewModeChange }: MessageViewerProps) {
  const [internalViewMode, setInternalViewMode] = useState<ViewMode>('body');
  const [copied, setCopied] = useState(false);

  // Use controlled mode if props are provided, otherwise use internal state
  const viewMode = controlledViewMode ?? internalViewMode;
  const setViewMode = onViewModeChange ?? setInternalViewMode;

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const { formattedBody, language } = useMemo(() => {
    try {
      const parsed = JSON.parse(message.body);
      return { formattedBody: JSON.stringify(parsed, null, 2), language: 'json' };
    } catch {
      // Check if XML
      if (message.body.trim().startsWith('<')) {
        return { formattedBody: message.body, language: 'xml' };
      }
      return { formattedBody: message.body, language: 'plaintext' };
    }
  }, [message.body]);

  // Byte length of the body (not character count) so multi-byte payloads report accurately.
  const bodySize = useMemo(() => formatBytes(new TextEncoder().encode(message.body).length), [message.body]);

  // Absolute expiry (EnqueuedTime + TTL). Hidden for scheduled messages (not enqueued yet)
  // and when the SDK reports ~year 9999 (DateTimeOffset.MaxValue = effectively never expires).
  const expiresAt = useMemo(() => {
    if (message.state === 'Scheduled' || !message.expiresAt) return null;
    const d = new Date(message.expiresAt);
    if (isNaN(d.getTime()) || d.getFullYear() >= 9999) return null;
    return d;
  }, [message.expiresAt, message.state]);

  // Application properties minus the dead-letter keys (shown in the Dead Letter Info section).
  const appProperties = useMemo(
    () => Object.entries(message.applicationProperties ?? {}).filter(([key]) => !DLQ_PROPERTY_KEYS.has(key)),
    [message.applicationProperties]
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Toolbar - height matches MessagePanel counter bar */}
      <div className="px-3 h-[46px] border-b border-dark-700 flex items-center justify-between">
        <div data-tour="message-view-tabs" className="flex items-center gap-1 bg-dark-800 rounded-lg p-1">
          <button
            onClick={() => setViewMode('body')}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${viewMode === 'body' ? 'bg-primary-500 text-white' : 'text-dark-400 hover:text-white'}`}
          >
            <FileJson className="w-4 h-4 inline mr-1" />
            Body
          </button>
          <button
            onClick={() => setViewMode('properties')}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${viewMode === 'properties' ? 'bg-primary-500 text-white' : 'text-dark-400 hover:text-white'}`}
          >
            <Code className="w-4 h-4 inline mr-1" />
            Properties
          </button>
        </div>
        <div className="flex items-center gap-2">
          {onUseAsTemplate && (
            <button
              onClick={() => onUseAsTemplate(message)}
              className="flex items-center gap-1 px-2 py-1 text-sm text-dark-400 hover:text-white transition-colors"
              title="Use as template for new message"
            >
              <FileInput className="w-4 h-4" />
              Template
            </button>
          )}
          <button
            onClick={() => copyToClipboard(viewMode === 'properties' ? JSON.stringify(message, null, 2) : message.body)}
            className="flex items-center gap-1 px-2 py-1 text-sm text-dark-400 hover:text-white transition-colors"
          >
            {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden min-h-0">
        {viewMode === 'properties' ? (
          <div className="h-full overflow-auto p-4 space-y-4">
            <PropertySection title="System Properties">
              <PropertyRow label="Message ID" value={message.messageId} />
              <PropertyRow label="Sequence Number" value={message.sequenceNumber.toString()} />
              <PropertyRow label="State" value={message.state} />
              {message.scheduledEnqueueTime && (
                <PropertyRow label="Schedule" value={<DateTimeText value={message.scheduledEnqueueTime} />} />
              )}
              {message.state !== 'Scheduled' && (
                <PropertyRow label="Enqueued Time" value={<DateTimeText value={message.enqueuedTime} />} />
              )}
              <PropertyRow label="Content Type" value={message.contentType} />
              <PropertyRow label="Body Size" value={bodySize} />
              <PropertyRow label="Subject" value={message.subject} />
              <PropertyRow label="Correlation ID" value={message.correlationId} />
              <PropertyRow label="Session ID" value={message.sessionId} />
              <PropertyRow label="Reply To" value={message.replyTo} />
              <PropertyRow label="Reply To Session ID" value={message.replyToSessionId} />
              <PropertyRow label="To" value={message.to} />
              <PropertyRow label="Time To Live" value={message.timeToLive} />
              {expiresAt && <PropertyRow label="Expires At" value={<DateTimeText value={expiresAt} />} />}
              <PropertyRow label="Delivery Count" value={message.deliveryCount.toString()} />
            </PropertySection>

            {(message.deadLetterReason || message.deadLetterErrorDescription || message.deadLetterSource) && (
              <PropertySection title="Dead Letter Info">
                <PropertyRow label="Reason" value={message.deadLetterReason} />
                <PropertyRow label="Description" value={message.deadLetterErrorDescription} />
                <PropertyRow label="Source" value={message.deadLetterSource} />
              </PropertySection>
            )}

            {appProperties.length > 0 && (
              <PropertySection title="Application Properties">
                {appProperties.map(([key, value]) => {
                  const type = message.applicationPropertyTypes?.[key];
                  return (
                    <PropertyRow
                      key={key}
                      label={type && type !== 'string' ? `${key} (${type})` : key}
                      value={String(value)}
                    />
                  );
                })}
              </PropertySection>
            )}
          </div>
        ) : (
          <Editor
            height="100%"
            language={language}
            value={formattedBody}
            theme="vs-dark"
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: 'on',
              padding: { top: 12 },
            }}
          />
        )}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function PropertySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-dark-400 uppercase tracking-wider mb-2">{title}</h3>
      <div className="bg-dark-800 rounded-lg divide-y divide-dark-700">{children}</div>
    </div>
  );
}

function PropertyRow({ label, value }: { label: string; value?: React.ReactNode }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 px-3 py-2">
      <span className="text-sm text-dark-400 break-words">{label}</span>
      <span className="text-sm text-white break-all">{value}</span>
    </div>
  );
}
