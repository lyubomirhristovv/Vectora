import { useState, useEffect } from "react";
import { X, Loader2 } from "lucide-react";
import type {
  Connection,
  QueueInfo,
  TopicInfo,
  EntityStatus,
  QueueProperties,
  TopicProperties,
  SubscriptionProperties,
  UpdateQueueRequest,
  UpdateTopicRequest,
  UpdateSubscriptionRequest,
} from "../types";
import {
  getQueueProperties,
  getTopicProperties,
  getSubscriptionProperties,
  updateQueue,
  updateTopic,
  updateSubscription,
} from "../api/client";
import {
  DurationInput,
  ForwardToSelector,
  LOCK_DURATION_FIELD,
  TTL_FIELD,
  formatDuration,
  parseDuration,
  validateDuration,
} from "./entityFormFields";

const STATUS_OPTIONS: EntityStatus[] = [
  "Active",
  "Disabled",
  "SendDisabled",
  "ReceiveDisabled",
];
const TOPIC_STATUS_OPTIONS: EntityStatus[] = [
  "Active",
  "Disabled",
  "SendDisabled",
]; // Topics cannot have ReceiveDisabled

interface EditEntityDialogProps {
  connection: Connection;
  entityType: "queue" | "topic" | "subscription";
  entityName: string;
  topicName?: string; // Required for subscriptions
  queues: QueueInfo[];
  topics: TopicInfo[];
  onClose: () => void;
  onSaved: () => void;
}

interface QueueFormProps {
  properties: QueueProperties;
  queues: QueueInfo[];
  topics: TopicInfo[];
  onSave: (data: UpdateQueueRequest) => Promise<void>;
  saving: boolean;
}

function QueueForm({
  properties,
  queues,
  topics,
  onSave,
  saving,
}: QueueFormProps) {
  const [status, setStatus] = useState<EntityStatus>(properties.status);
  const [ttl, setTtl] = useState(
    parseDuration(properties.defaultMessageTimeToLive),
  );
  const [lockDuration, setLockDuration] = useState(
    parseDuration(properties.lockDuration),
  );
  const [maxDeliveryCount, setMaxDeliveryCount] = useState(
    properties.maxDeliveryCount,
  );
  const [deadLetterOnExpiration, setDeadLetterOnExpiration] = useState(
    properties.deadLetteringOnMessageExpiration,
  );
  const [forwardTo, setForwardTo] = useState(properties.forwardTo || "");
  const [forwardDlq, setForwardDlq] = useState(
    properties.forwardDeadLetteredMessagesTo || "",
  );

  const durationError =
    validateDuration(ttl, TTL_FIELD) ||
    validateDuration(lockDuration, LOCK_DURATION_FIELD);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (durationError) return;
    onSave({
      status,
      defaultMessageTimeToLive: formatDuration(ttl),
      lockDuration: formatDuration(lockDuration),
      maxDeliveryCount,
      deadLetteringOnMessageExpiration: deadLetterOnExpiration,
      forwardTo: forwardTo || null,
      forwardDeadLetteredMessagesTo: forwardDlq || null,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm text-dark-400 mb-1">Status</label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as EntityStatus)}
          className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded text-white text-sm"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <DurationInput
          label="Message TTL"
          value={ttl}
          onChange={setTtl}
          {...TTL_FIELD}
        />
        <DurationInput
          label="Lock Duration"
          value={lockDuration}
          onChange={setLockDuration}
          {...LOCK_DURATION_FIELD}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm text-dark-400 mb-1">
            Max Delivery Count
          </label>
          <input
            type="number"
            value={maxDeliveryCount}
            onChange={(e) => setMaxDeliveryCount(parseInt(e.target.value) || 1)}
            min={1}
            className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded text-white text-sm"
          />
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 cursor-pointer pb-2">
            <input
              type="checkbox"
              checked={deadLetterOnExpiration}
              onChange={(e) => setDeadLetterOnExpiration(e.target.checked)}
              className="w-4 h-4 rounded bg-dark-700 border-dark-600"
            />
            <span className="text-sm text-dark-300">
              Dead-letter on expiration
            </span>
          </label>
        </div>
      </div>
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
      <div className="flex justify-end pt-8 mt-4">
        <button
          type="submit"
          disabled={saving || !!durationError}
          className="px-4 py-2 bg-primary-500 hover:bg-primary-400 text-white rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-2"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Save Changes
        </button>
      </div>
    </form>
  );
}

interface TopicFormProps {
  properties: TopicProperties;
  onSave: (data: UpdateTopicRequest) => Promise<void>;
  saving: boolean;
}

function TopicForm({ properties, onSave, saving }: TopicFormProps) {
  const [status, setStatus] = useState<EntityStatus>(properties.status);
  const [ttl, setTtl] = useState(
    parseDuration(properties.defaultMessageTimeToLive),
  );

  const durationError = validateDuration(ttl, TTL_FIELD);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (durationError) return;
    onSave({
      status,
      defaultMessageTimeToLive: formatDuration(ttl),
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm text-dark-400 mb-1">Status</label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as EntityStatus)}
          className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded text-white text-sm"
        >
          {TOPIC_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <DurationInput
        label="Default Message TTL"
        value={ttl}
        onChange={setTtl}
        {...TTL_FIELD}
      />
      <p className="text-xs text-dark-500">
        Topics have fewer editable properties. Other settings are fixed at
        creation time.
      </p>
      <div className="flex justify-end pt-8 mt-4">
        <button
          type="submit"
          disabled={saving || !!durationError}
          className="px-4 py-2 bg-primary-500 hover:bg-primary-400 text-white rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-2"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Save Changes
        </button>
      </div>
    </form>
  );
}

interface SubscriptionFormProps {
  properties: SubscriptionProperties;
  queues: QueueInfo[];
  topics: TopicInfo[];
  onSave: (data: UpdateSubscriptionRequest) => Promise<void>;
  saving: boolean;
}

function SubscriptionForm({
  properties,
  queues,
  topics,
  onSave,
  saving,
}: SubscriptionFormProps) {
  const [status, setStatus] = useState<EntityStatus>(properties.status);
  const [ttl, setTtl] = useState(
    parseDuration(properties.defaultMessageTimeToLive),
  );
  const [lockDuration, setLockDuration] = useState(
    parseDuration(properties.lockDuration),
  );
  const [maxDeliveryCount, setMaxDeliveryCount] = useState(
    properties.maxDeliveryCount,
  );
  const [deadLetterOnExpiration, setDeadLetterOnExpiration] = useState(
    properties.deadLetteringOnMessageExpiration,
  );
  const [forwardTo, setForwardTo] = useState(properties.forwardTo || "");
  const [forwardDlq, setForwardDlq] = useState(
    properties.forwardDeadLetteredMessagesTo || "",
  );

  const durationError =
    validateDuration(ttl, TTL_FIELD) ||
    validateDuration(lockDuration, LOCK_DURATION_FIELD);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (durationError) return;
    onSave({
      status,
      defaultMessageTimeToLive: formatDuration(ttl),
      lockDuration: formatDuration(lockDuration),
      maxDeliveryCount,
      deadLetteringOnMessageExpiration: deadLetterOnExpiration,
      forwardTo: forwardTo || null,
      forwardDeadLetteredMessagesTo: forwardDlq || null,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm text-dark-400 mb-1">Status</label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as EntityStatus)}
          className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded text-white text-sm"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <DurationInput
          label="Message TTL"
          value={ttl}
          onChange={setTtl}
          {...TTL_FIELD}
        />
        <DurationInput
          label="Lock Duration"
          value={lockDuration}
          onChange={setLockDuration}
          {...LOCK_DURATION_FIELD}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm text-dark-400 mb-1">
            Max Delivery Count
          </label>
          <input
            type="number"
            value={maxDeliveryCount}
            onChange={(e) => setMaxDeliveryCount(parseInt(e.target.value) || 1)}
            min={1}
            className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded text-white text-sm"
          />
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 cursor-pointer pb-2">
            <input
              type="checkbox"
              checked={deadLetterOnExpiration}
              onChange={(e) => setDeadLetterOnExpiration(e.target.checked)}
              className="w-4 h-4 rounded bg-dark-700 border-dark-600"
            />
            <span className="text-sm text-dark-300">
              Dead-letter on expiration
            </span>
          </label>
        </div>
      </div>
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
      <div className="flex justify-end pt-8 mt-4">
        <button
          type="submit"
          disabled={saving || !!durationError}
          className="px-4 py-2 bg-primary-500 hover:bg-primary-400 text-white rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-2"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Save Changes
        </button>
      </div>
    </form>
  );
}

export default function EditEntityDialog({
  connection,
  entityType,
  entityName,
  topicName,
  queues,
  topics,
  onClose,
  onSaved,
}: EditEntityDialogProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [queueProps, setQueueProps] = useState<QueueProperties | null>(null);
  const [topicProps, setTopicProps] = useState<TopicProperties | null>(null);
  const [subscriptionProps, setSubscriptionProps] =
    useState<SubscriptionProperties | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        if (entityType === "queue") {
          const props = await getQueueProperties(connection.id, entityName);
          setQueueProps(props);
        } else if (entityType === "topic") {
          const props = await getTopicProperties(connection.id, entityName);
          setTopicProps(props);
        } else if (entityType === "subscription" && topicName) {
          const props = await getSubscriptionProperties(
            connection.id,
            topicName,
            entityName,
          );
          setSubscriptionProps(props);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load properties",
        );
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [connection.id, entityType, entityName, topicName]);

  const handleSaveQueue = async (data: UpdateQueueRequest) => {
    setSaving(true);
    setError("");
    try {
      await updateQueue(connection.id, entityName, data);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTopic = async (data: UpdateTopicRequest) => {
    setSaving(true);
    setError("");
    try {
      await updateTopic(connection.id, entityName, data);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSubscription = async (data: UpdateSubscriptionRequest) => {
    if (!topicName) return;
    setSaving(true);
    setError("");
    try {
      await updateSubscription(connection.id, topicName, entityName, data);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // Close when a click starts on the backdrop (mousedown, so a drag that
  // starts inside the dialog and ends outside doesn't close it)
  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && e.button === 0) onClose();
  };

  const title =
    entityType === "queue"
      ? `Edit Queue: ${entityName}`
      : entityType === "topic"
        ? `Edit Topic: ${entityName}`
        : `Edit Subscription: ${entityName}`;

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
          <h3 className="text-lg font-semibold text-white truncate">{title}</h3>
          <button onClick={onClose} className="text-dark-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 pb-6 overflow-y-auto flex-1">
          {error && (
            <div className="mb-4 p-2 bg-red-500/10 border border-red-500/20 rounded text-red-400 text-sm">
              {error}
            </div>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary-400" />
            </div>
          ) : (
            <>
              {entityType === "queue" && queueProps && (
                <QueueForm
                  properties={queueProps}
                  queues={queues}
                  topics={topics}
                  onSave={handleSaveQueue}
                  saving={saving}
                />
              )}
              {entityType === "topic" && topicProps && (
                <TopicForm
                  properties={topicProps}
                  onSave={handleSaveTopic}
                  saving={saving}
                />
              )}
              {entityType === "subscription" && subscriptionProps && (
                <SubscriptionForm
                  properties={subscriptionProps}
                  queues={queues}
                  topics={topics}
                  onSave={handleSaveSubscription}
                  saving={saving}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
