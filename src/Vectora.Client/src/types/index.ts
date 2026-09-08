export interface Connection {
  id: number;
  name: string;
  connectionString: string;
  isEmulator: boolean;
  mcpExposed: boolean;
  mcpAllowSend: boolean;
  sortOrder: number;
}

export interface QueueInfo {
  name: string;
  activeMessageCount: number;
  deadLetterMessageCount: number;
  // False when the count is a floor rather than a total (rendered "N+"). Emulator only.
  activeCountExact?: boolean;
  deadLetterCountExact?: boolean;
  isEmulator: boolean;
  requiresSession: boolean;
}

export interface TopicInfo {
  name: string;
  subscriptions: SubscriptionInfo[];
  isEmulator: boolean;
}

export interface SubscriptionInfo {
  name: string;
  activeMessageCount: number;
  deadLetterMessageCount: number;
  activeCountExact?: boolean;
  deadLetterCountExact?: boolean;
  requiresSession: boolean;
}

export interface SessionInfo {
  sessionId: string;
  messageCount: number;
  lastEnqueuedTime?: string;
}

// Result of peeking one page of messages and grouping by session id.
// `lastSequenceNumber + 1` is the cursor to pass as the next fromSequenceNumber.
export interface SessionScanResult {
  sessions: SessionInfo[];
  scannedCount: number;
  lastSequenceNumber: number | null;
  reachedEnd: boolean;
}

// Result of peeking one page of messages and filtering to a single session.
export interface SessionMessageScanResult {
  messages: ServiceBusMessage[];
  scannedCount: number;
  lastSequenceNumber: number | null;
  reachedEnd: boolean;
}

export interface ServiceBusMessage {
  messageId: string;
  body: string;
  contentType?: string;
  subject?: string;
  correlationId?: string;
  replyTo?: string;
  replyToSessionId?: string;
  sessionId?: string;
  to?: string;
  sequenceNumber: number;
  enqueuedTime: string;
  scheduledEnqueueTime?: string;
  state: string; // 'Active' | 'Scheduled' | 'Deferred'
  timeToLive: string;
  expiresAt: string;
  deliveryCount: number;
  deadLetterReason?: string;
  deadLetterErrorDescription?: string;
  deadLetterSource?: string;
  applicationProperties?: Record<string, unknown>;
  // Backend-reported CLR type per application property ('string' | 'int' | 'long' | ...),
  // used to preserve the original types when the message is used as a send template.
  applicationPropertyTypes?: Record<string, string>;
}

// Wire type names for typed application properties (must match the backend converter).
export const APPLICATION_PROPERTY_TYPES = ['string', 'bool', 'int', 'long', 'double', 'decimal', 'guid', 'datetime', 'timespan'] as const;
export type ApplicationPropertyType = typeof APPLICATION_PROPERTY_TYPES[number];

export interface SendMessageRequest {
  body: string;
  contentType?: string;
  subject?: string;
  messageId?: string;
  correlationId?: string;
  replyTo?: string;
  replyToSessionId?: string;
  sessionId?: string;
  to?: string;
  scheduledEnqueueTime?: string;
  timeToLive?: string;
  applicationProperties?: Record<string, { value: string; type: ApplicationPropertyType }>;
}

export type EntityStatus = 'Active' | 'Disabled' | 'SendDisabled' | 'ReceiveDisabled';

export interface QueueProperties {
  name: string;
  status: EntityStatus;
  defaultMessageTimeToLive: string;
  lockDuration: string;
  maxDeliveryCount: number;
  requiresDuplicateDetection: boolean;
  requiresSession: boolean;
  deadLetteringOnMessageExpiration: boolean;
  forwardTo?: string;
  forwardDeadLetteredMessagesTo?: string;
  maxSizeInMegabytes: number;
}

export interface TopicProperties {
  name: string;
  status: EntityStatus;
  defaultMessageTimeToLive: string;
  requiresDuplicateDetection: boolean;
  maxSizeInMegabytes: number;
}

export interface SubscriptionProperties {
  name: string;
  topicName: string;
  status: EntityStatus;
  defaultMessageTimeToLive: string;
  lockDuration: string;
  maxDeliveryCount: number;
  requiresSession: boolean;
  deadLetteringOnMessageExpiration: boolean;
  forwardTo?: string;
  forwardDeadLetteredMessagesTo?: string;
}

export interface CreateConnectionRequest {
  name: string;
  connectionString: string;
}

export interface CreateQueueRequest {
  name: string;
  defaultMessageTimeToLive?: string;
  lockDuration?: string;
  maxDeliveryCount?: number;
  requiresDuplicateDetection?: boolean;
  requiresSession?: boolean;
  deadLetteringOnMessageExpiration?: boolean;
  forwardTo?: string;
  forwardDeadLetteredMessagesTo?: string;
}

export interface CreateTopicRequest {
  name: string;
  defaultMessageTimeToLive?: string;
  requiresDuplicateDetection?: boolean;
}

export interface CreateSubscriptionRequest {
  name: string;
  defaultMessageTimeToLive?: string;
  lockDuration?: string;
  maxDeliveryCount?: number;
  requiresSession?: boolean;
  deadLetteringOnMessageExpiration?: boolean;
  forwardTo?: string;
  forwardDeadLetteredMessagesTo?: string;
}

export type EntityType = 'queue' | 'topic' | 'subscription';

export interface SelectedEntity {
  type: EntityType;
  name: string;
  topicName?: string; // For subscriptions
}

// Update request types
export interface UpdateQueueRequest {
  status?: EntityStatus;
  defaultMessageTimeToLive?: string;
  lockDuration?: string;
  maxDeliveryCount?: number;
  deadLetteringOnMessageExpiration?: boolean;
  forwardTo?: string | null;
  forwardDeadLetteredMessagesTo?: string | null;
}

export interface UpdateTopicRequest {
  status?: EntityStatus;
  defaultMessageTimeToLive?: string;
}

export interface UpdateSubscriptionRequest {
  status?: EntityStatus;
  defaultMessageTimeToLive?: string;
  lockDuration?: string;
  maxDeliveryCount?: number;
  deadLetteringOnMessageExpiration?: boolean;
  forwardTo?: string | null;
  forwardDeadLetteredMessagesTo?: string | null;
}

export interface MessageTemplate {
  id: number;
  name: string;
  body: string;
  contentType?: string;
  subject?: string;
  messageId?: string;
  correlationId?: string;
  sessionId?: string;
  applicationProperties?: string;
  sendMultiple: boolean;
  sendCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveMessageTemplateRequest {
  name: string;
  body: string;
  contentType?: string;
  subject?: string;
  messageId?: string;
  correlationId?: string;
  sessionId?: string;
  applicationProperties?: string;
  sendMultiple: boolean;
  sendCount: number;
}

export interface SearchHistoryEntry {
  term: string;
  isFavorite: boolean;
  lastSearchedAt: string;
}
