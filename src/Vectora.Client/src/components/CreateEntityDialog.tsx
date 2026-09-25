import { useState } from "react";
import { X, Loader2 } from "lucide-react";
import type {
  QueueInfo,
  TopicInfo,
  CreateQueueRequest,
  CreateTopicRequest,
  CreateSubscriptionRequest,
} from "../types";
import {
  AUTO_DELETE_FIELD,
  DUPLICATE_DETECTION_FIELD,
  DurationInput,
  ForwardToSelector,
  LOCK_DURATION_FIELD,
  TTL_FIELD,
  formatDuration,
  validateDuration,
} from "./entityFormFields";

export type CreateEntityPayload =
  | { type: "queue"; data: CreateQueueRequest }
  | { type: "topic"; data: CreateTopicRequest }
  | {
      type: "subscription";
      topicName: string;
      data: CreateSubscriptionRequest;
    };

// Sizes accepted by Azure Service Bus for a non-partitioned entity
const MAX_SIZE_OPTIONS = [1024, 2048, 3072, 4096, 5120];

interface CreateEntityDialogProps {
  entityType: "queue" | "topic" | "subscription";
  queues: QueueInfo[];
  topics: TopicInfo[];
  initialTopicName?: string;
  creating: boolean;
  error: string;
  onClose: () => void;
  onCreate: (payload: CreateEntityPayload) => void;
}

const inputClass =
  "w-full px-3 py-2 bg-dark-900 border border-dark-500 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500";

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

function Checkbox({ checked, onChange, label }: CheckboxProps) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded bg-dark-700 border-dark-600"
      />
      <span className="text-sm text-dark-300">{label}</span>
    </label>
  );
}

export default function CreateEntityDialog({
  entityType,
  queues,
  topics,
  initialTopicName,
  creating,
  error,
  onClose,
  onCreate,
}: CreateEntityDialogProps) {
  const [name, setName] = useState("");
  const [topicName, setTopicName] = useState(initialTopicName ?? "");
  const [ttl, setTtl] = useState("Never");
  const [lockDuration, setLockDuration] = useState("1m");
  const [autoDeleteOnIdle, setAutoDeleteOnIdle] = useState("Never");
  const [maxDeliveryCount, setMaxDeliveryCount] = useState(10);
  const [maxSize, setMaxSize] = useState(1024);
  const [requiresSession, setRequiresSession] = useState(false);
  const [requiresDuplicateDetection, setRequiresDuplicateDetection] =
    useState(false);
  const [duplicateDetectionWindow, setDuplicateDetectionWindow] =
    useState("10m");
  const [deadLetterOnExpiration, setDeadLetterOnExpiration] = useState(false);
  const [deadLetterOnFilterException, setDeadLetterOnFilterException] =
    useState(true);
  const [enableBatchedOperations, setEnableBatchedOperations] = useState(true);
  const [enablePartitioning, setEnablePartitioning] = useState(false);
  const [supportOrdering, setSupportOrdering] = useState(false);
  const [forwardTo, setForwardTo] = useState("");
  const [forwardDlq, setForwardDlq] = useState("");

  const durationError =
    validateDuration(ttl, TTL_FIELD) ||
    validateDuration(autoDeleteOnIdle, AUTO_DELETE_FIELD) ||
    (entityType !== "topic"
      ? validateDuration(lockDuration, LOCK_DURATION_FIELD)
      : null) ||
    (entityType !== "subscription" && requiresDuplicateDetection
      ? validateDuration(duplicateDetectionWindow, DUPLICATE_DETECTION_FIELD)
      : null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating || durationError) return;

    if (entityType === "queue") {
      onCreate({
        type: "queue",
        data: {
          name: trimmed,
          defaultMessageTimeToLive: formatDuration(ttl),
          lockDuration: formatDuration(lockDuration),
          autoDeleteOnIdle: formatDuration(autoDeleteOnIdle),
          maxDeliveryCount,
          maxSizeInMegabytes: maxSize,
          requiresSession,
          requiresDuplicateDetection,
          ...(requiresDuplicateDetection
            ? {
                duplicateDetectionHistoryTimeWindow: formatDuration(
                  duplicateDetectionWindow,
                ),
              }
            : {}),
          deadLetteringOnMessageExpiration: deadLetterOnExpiration,
          enableBatchedOperations,
          enablePartitioning,
          forwardTo: forwardTo || undefined,
          forwardDeadLetteredMessagesTo: forwardDlq || undefined,
        },
      });
    } else if (entityType === "topic") {
      onCreate({
        type: "topic",
        data: {
          name: trimmed,
          defaultMessageTimeToLive: formatDuration(ttl),
          autoDeleteOnIdle: formatDuration(autoDeleteOnIdle),
          maxSizeInMegabytes: maxSize,
          requiresDuplicateDetection,
          ...(requiresDuplicateDetection
            ? {
                duplicateDetectionHistoryTimeWindow: formatDuration(
                  duplicateDetectionWindow,
                ),
              }
            : {}),
          enableBatchedOperations,
          enablePartitioning,
          supportOrdering,
        },
      });
    } else {
      onCreate({
        type: "subscription",
        topicName,
        data: {
          name: trimmed,
          defaultMessageTimeToLive: formatDuration(ttl),
          lockDuration: formatDuration(lockDuration),
          autoDeleteOnIdle: formatDuration(autoDeleteOnIdle),
          maxDeliveryCount,
          requiresSession,
          deadLetteringOnMessageExpiration: deadLetterOnExpiration,
          deadLetteringOnFilterEvaluationExceptions:
            deadLetterOnFilterException,
          enableBatchedOperations,
          forwardTo: forwardTo || undefined,
          forwardDeadLetteredMessagesTo: forwardDlq || undefined,
        },
      });
    }
  };

  // Close when a click starts on the backdrop (mousedown, so a drag that
  // starts inside the dialog and ends outside doesn't close it)
  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && e.button === 0) onClose();
  };

  const title =
    entityType === "queue"
      ? "Create Queue"
      : entityType === "topic"
        ? "Create Topic"
        : "Create Subscription";

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="bg-dark-800 border border-dark-600 rounded-xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-dark-600">
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <button onClick={onClose} className="text-dark-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form
          onSubmit={handleSubmit}
          className="p-4 overflow-y-auto flex-1 space-y-4"
        >
          {error && (
            <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-red-400 text-sm">
              {error}
            </div>
          )}
          {entityType === "subscription" && (
            <div>
              <label className="block text-sm text-dark-400 mb-1">Topic</label>
              <select
                value={topicName}
                onChange={(e) => setTopicName(e.target.value)}
                className={inputClass}
              >
                <option value="">Select topic...</option>
                {topics.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm text-dark-400 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`Enter ${entityType} name`}
              className={inputClass}
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <DurationInput
              label="Message TTL"
              value={ttl}
              onChange={setTtl}
              inputClassName={inputClass}
              {...TTL_FIELD}
            />
            <DurationInput
              label="Auto-delete on Idle"
              value={autoDeleteOnIdle}
              onChange={setAutoDeleteOnIdle}
              inputClassName={inputClass}
              {...AUTO_DELETE_FIELD}
            />
          </div>
          {entityType !== "topic" && (
            <div className="grid grid-cols-2 gap-3">
              <DurationInput
                label="Lock Duration"
                value={lockDuration}
                onChange={setLockDuration}
                inputClassName={inputClass}
                {...LOCK_DURATION_FIELD}
              />
              <div>
                <label className="block text-sm text-dark-400 mb-1">
                  Max Delivery Count
                </label>
                <input
                  type="number"
                  value={maxDeliveryCount}
                  onChange={(e) =>
                    setMaxDeliveryCount(parseInt(e.target.value) || 1)
                  }
                  min={1}
                  className={inputClass}
                />
              </div>
            </div>
          )}
          {entityType !== "subscription" && (
            <div>
              <label className="block text-sm text-dark-400 mb-1">
                Max Size
              </label>
              <select
                value={maxSize}
                onChange={(e) => setMaxSize(parseInt(e.target.value))}
                className={inputClass}
              >
                {MAX_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size >= 1024 ? `${size / 1024} GB` : `${size} MB`}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-2">
            {entityType !== "topic" && (
              <Checkbox
                checked={requiresSession}
                onChange={setRequiresSession}
                label="Enable sessions"
              />
            )}
            {entityType !== "subscription" && (
              <Checkbox
                checked={requiresDuplicateDetection}
                onChange={setRequiresDuplicateDetection}
                label="Enable duplicate detection"
              />
            )}
            {entityType !== "subscription" && requiresDuplicateDetection && (
              <div className="pl-6">
                <DurationInput
                  label="Duplicate Detection Window"
                  value={duplicateDetectionWindow}
                  onChange={setDuplicateDetectionWindow}
                  inputClassName={inputClass}
                  {...DUPLICATE_DETECTION_FIELD}
                />
              </div>
            )}
            {entityType !== "topic" && (
              <Checkbox
                checked={deadLetterOnExpiration}
                onChange={setDeadLetterOnExpiration}
                label="Dead-letter on expiration"
              />
            )}
            {entityType === "subscription" && (
              <Checkbox
                checked={deadLetterOnFilterException}
                onChange={setDeadLetterOnFilterException}
                label="Dead-letter on filter evaluation exceptions"
              />
            )}
            <Checkbox
              checked={enableBatchedOperations}
              onChange={setEnableBatchedOperations}
              label="Enable batched operations"
            />
            {entityType !== "subscription" && (
              <Checkbox
                checked={enablePartitioning}
                onChange={setEnablePartitioning}
                label="Enable partitioning"
              />
            )}
            {entityType === "topic" && (
              <Checkbox
                checked={supportOrdering}
                onChange={setSupportOrdering}
                label="Support ordering"
              />
            )}
          </div>
          {entityType !== "topic" && (
            <>
              <ForwardToSelector
                value={forwardTo}
                onChange={setForwardTo}
                queues={queues}
                topics={topics}
                label="Forward To"
              />
              <ForwardToSelector
                value={forwardDlq}
                onChange={setForwardDlq}
                queues={queues}
                topics={topics}
                label="Forward Dead-lettered Messages To"
              />
            </>
          )}
          <div className="flex gap-2 justify-end pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 bg-dark-600 hover:bg-dark-500 text-white text-sm rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating || !name.trim() || !!durationError}
              className="px-3 py-1.5 bg-primary-500 hover:bg-primary-400 text-white text-sm rounded-lg disabled:opacity-50 flex items-center gap-2"
            >
              {creating && <Loader2 className="w-4 h-4 animate-spin" />}
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
