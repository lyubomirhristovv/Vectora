import type {
  Connection, QueueInfo, TopicInfo, SubscriptionInfo, ServiceBusMessage, SendMessageRequest,
  CreateConnectionRequest, CreateQueueRequest, CreateTopicRequest, CreateSubscriptionRequest,
  QueueProperties, TopicProperties, SubscriptionProperties,
  UpdateQueueRequest, UpdateTopicRequest, UpdateSubscriptionRequest,
  MessageTemplate, SaveMessageTemplateRequest,
  SessionScanResult, SessionMessageScanResult, SearchHistoryEntry
} from '../types';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function getToken(): string | null {
  return localStorage.getItem('vectora_token');
}

async function fetchApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {
    // Only set Content-Type if there's a body
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });

  // Only an auth-layer 401 (expired/missing app token) should drop the session and reload.
  // The backend tags those with X-Auth-Failure; any other 401 (e.g. a Service Bus resource
  // error) is surfaced as a normal error so a bad connection can't loop the page forever.
  if (response.status === 401 && response.headers.get('X-Auth-Failure') === '1') {
    localStorage.removeItem('vectora_token');
    window.location.reload();
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  // Handle empty response body
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text);
}

// Auth
export async function getAuthStatus(): Promise<{ authRequired: boolean }> {
  const response = await fetch(`${API_BASE}/auth/status`);
  return response.json();
}

export async function login(password: string): Promise<{ success: boolean; token?: string; error?: string }> {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return response.json();
}

export async function validateToken(token: string): Promise<boolean> {
  const response = await fetch(`${API_BASE}/auth/validate`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return response.ok;
}

// Connections
export const getConnections = () => fetchApi<Connection[]>('/connections');
export const getConnection = (id: number) => fetchApi<Connection>(`/connections/${id}`);
export const createConnection = (data: CreateConnectionRequest) => 
  fetchApi<Connection>('/connections', { method: 'POST', body: JSON.stringify(data) });
export const updateConnection = (id: number, data: Partial<CreateConnectionRequest>) =>
  fetchApi<Connection>(`/connections/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteConnection = (id: number) =>
  fetchApi<void>(`/connections/${id}`, { method: 'DELETE' });
export const updateConnectionMcpFlags = (id: number, mcpExposed: boolean, mcpAllowSend: boolean) =>
  fetchApi<Connection>(`/connections/${id}/mcp`, { method: 'PUT', body: JSON.stringify({ mcpExposed, mcpAllowSend }) });
export const reorderConnections = (orderedIds: number[]) =>
  fetchApi<void>('/connections/reorder', { method: 'PUT', body: JSON.stringify({ orderedIds }) });

// Service Bus entities
export const getEntities = (connectionId: number, refreshCache = false, signal?: AbortSignal) =>
  fetchApi<{ queues: QueueInfo[]; topics: TopicInfo[]; countsPending: boolean }>(
    `/connections/${connectionId}/servicebus/entities${refreshCache ? '?refreshCache=true' : ''}`,
    { signal }
  );

// Queue operations
export const getQueueRuntimeInfo = (connectionId: number, queueName: string, recount = false) =>
  fetchApi<QueueInfo>(`/connections/${connectionId}/servicebus/queues/${encodeURIComponent(queueName)}/runtime${recount ? '?recount=true' : ''}`);
export const getQueueProperties = (connectionId: number, queueName: string) =>
  fetchApi<QueueProperties>(`/connections/${connectionId}/servicebus/queues/${encodeURIComponent(queueName)}/properties`);
export const createQueue = (connectionId: number, data: CreateQueueRequest) =>
  fetchApi<void>(`/connections/${connectionId}/servicebus/queues`, { method: 'POST', body: JSON.stringify(data) });
export const deleteQueue = (connectionId: number, queueName: string) =>
  fetchApi<void>(`/connections/${connectionId}/servicebus/queues/${encodeURIComponent(queueName)}`, { method: 'DELETE' });
export const updateQueue = (connectionId: number, queueName: string, data: UpdateQueueRequest) =>
  fetchApi<void>(`/connections/${connectionId}/servicebus/queues/${encodeURIComponent(queueName)}`, { method: 'PUT', body: JSON.stringify(data) });

// Topic operations
export const getTopicProperties = (connectionId: number, topicName: string) =>
  fetchApi<TopicProperties>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/properties`);
export const createTopic = (connectionId: number, data: CreateTopicRequest) =>
  fetchApi<void>(`/connections/${connectionId}/servicebus/topics`, { method: 'POST', body: JSON.stringify(data) });
export const deleteTopic = (connectionId: number, topicName: string) =>
  fetchApi<void>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}`, { method: 'DELETE' });
export const updateTopic = (connectionId: number, topicName: string, data: UpdateTopicRequest) =>
  fetchApi<void>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}`, { method: 'PUT', body: JSON.stringify(data) });

// Subscription operations
export const getSubscriptionRuntimeInfo = (connectionId: number, topicName: string, subscriptionName: string, recount = false) =>
  fetchApi<SubscriptionInfo>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/subscriptions/${encodeURIComponent(subscriptionName)}/runtime${recount ? '?recount=true' : ''}`);
export const getSubscriptionProperties = (connectionId: number, topicName: string, subscriptionName: string) =>
  fetchApi<SubscriptionProperties>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/subscriptions/${encodeURIComponent(subscriptionName)}/properties`);
export const createSubscription = (connectionId: number, topicName: string, data: CreateSubscriptionRequest) =>
  fetchApi<void>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/subscriptions`, { method: 'POST', body: JSON.stringify(data) });
export const deleteSubscription = (connectionId: number, topicName: string, subscriptionName: string) =>
  fetchApi<void>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/subscriptions/${encodeURIComponent(subscriptionName)}`, { method: 'DELETE' });
export const updateSubscription = (connectionId: number, topicName: string, subscriptionName: string, data: UpdateSubscriptionRequest) =>
  fetchApi<void>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/subscriptions/${encodeURIComponent(subscriptionName)}`, { method: 'PUT', body: JSON.stringify(data) });

// Messages
export const peekQueueMessages = (connectionId: number, queueName: string, maxMessages = 50, deadLetter = false, fromSequenceNumber?: number) =>
  fetchApi<ServiceBusMessage[]>(`/connections/${connectionId}/servicebus/queues/${encodeURIComponent(queueName)}/messages?maxMessages=${maxMessages}&deadLetter=${deadLetter}${fromSequenceNumber ? `&fromSequenceNumber=${fromSequenceNumber}` : ''}`);
export const peekSubscriptionMessages = (connectionId: number, topicName: string, subscriptionName: string, maxMessages = 50, deadLetter = false, fromSequenceNumber?: number) =>
  fetchApi<ServiceBusMessage[]>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/subscriptions/${encodeURIComponent(subscriptionName)}/messages?maxMessages=${maxMessages}&deadLetter=${deadLetter}${fromSequenceNumber ? `&fromSequenceNumber=${fromSequenceNumber}` : ''}`);

// Sessions (read-only peek; group by session id, then browse a single session).
// Page through deep queues by passing the previous result's lastSequenceNumber + 1.
export const scanQueueSessions = (connectionId: number, queueName: string, deadLetter = false, fromSequenceNumber?: number, scanLimit = 1000) =>
  fetchApi<SessionScanResult>(`/connections/${connectionId}/servicebus/queues/${encodeURIComponent(queueName)}/sessions?deadLetter=${deadLetter}&scanLimit=${scanLimit}${fromSequenceNumber != null ? `&fromSequenceNumber=${fromSequenceNumber}` : ''}`);
export const scanSubscriptionSessions = (connectionId: number, topicName: string, subscriptionName: string, deadLetter = false, fromSequenceNumber?: number, scanLimit = 1000) =>
  fetchApi<SessionScanResult>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/subscriptions/${encodeURIComponent(subscriptionName)}/sessions?deadLetter=${deadLetter}&scanLimit=${scanLimit}${fromSequenceNumber != null ? `&fromSequenceNumber=${fromSequenceNumber}` : ''}`);

export const peekQueueSessionMessages = (connectionId: number, queueName: string, sessionId: string, deadLetter = false, fromSequenceNumber?: number, scanLimit = 1000) =>
  fetchApi<SessionMessageScanResult>(`/connections/${connectionId}/servicebus/queues/${encodeURIComponent(queueName)}/sessions/messages?sessionId=${encodeURIComponent(sessionId)}&deadLetter=${deadLetter}&scanLimit=${scanLimit}${fromSequenceNumber != null ? `&fromSequenceNumber=${fromSequenceNumber}` : ''}`);
export const peekSubscriptionSessionMessages = (connectionId: number, topicName: string, subscriptionName: string, sessionId: string, deadLetter = false, fromSequenceNumber?: number, scanLimit = 1000) =>
  fetchApi<SessionMessageScanResult>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/subscriptions/${encodeURIComponent(subscriptionName)}/sessions/messages?sessionId=${encodeURIComponent(sessionId)}&deadLetter=${deadLetter}&scanLimit=${scanLimit}${fromSequenceNumber != null ? `&fromSequenceNumber=${fromSequenceNumber}` : ''}`);

// sessionId scopes the consume to a single session of a session-enabled entity.
export const receiveQueueMessages = (connectionId: number, queueName: string, maxMessages = 10, deadLetter = false, sessionId?: string) =>
  fetchApi<{ consumedCount: number }>(`/connections/${connectionId}/servicebus/queues/${encodeURIComponent(queueName)}/messages/receive?maxMessages=${maxMessages}&deadLetter=${deadLetter}${sessionId != null ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`, { method: 'POST' });
export const receiveSubscriptionMessages = (connectionId: number, topicName: string, subscriptionName: string, maxMessages = 10, deadLetter = false, sessionId?: string) =>
  fetchApi<{ consumedCount: number }>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/subscriptions/${encodeURIComponent(subscriptionName)}/messages/receive?maxMessages=${maxMessages}&deadLetter=${deadLetter}${sessionId != null ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`, { method: 'POST' });

export const sendToQueue = (connectionId: number, queueName: string, message: SendMessageRequest, count = 1) =>
  fetchApi<{ sentCount: number }>(`/connections/${connectionId}/servicebus/queues/${encodeURIComponent(queueName)}/messages?count=${count}`, { method: 'POST', body: JSON.stringify(message) });
export const sendToTopic = (connectionId: number, topicName: string, message: SendMessageRequest, count = 1) =>
  fetchApi<{ sentCount: number }>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/messages?count=${count}`, { method: 'POST', body: JSON.stringify(message) });

export const returnQueueDeadLetter = (connectionId: number, queueName: string, sequenceNumber: number, message?: SendMessageRequest, deleteOriginal = true) =>
  fetchApi<void>(`/connections/${connectionId}/servicebus/queues/${encodeURIComponent(queueName)}/deadletter/${sequenceNumber}/return?deleteOriginal=${deleteOriginal}`, { method: 'POST', body: JSON.stringify(message ?? null) });
export const returnSubscriptionDeadLetter = (connectionId: number, topicName: string, subscriptionName: string, sequenceNumber: number, message?: SendMessageRequest, deleteOriginal = true) =>
  fetchApi<void>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/subscriptions/${encodeURIComponent(subscriptionName)}/deadletter/${sequenceNumber}/return?deleteOriginal=${deleteOriginal}`, { method: 'POST', body: JSON.stringify(message ?? null) });

export const returnQueueDeadLetterBatch = (connectionId: number, queueName: string, sequenceNumbers: number[]) =>
  fetchApi<{ processed: number }>(`/connections/${connectionId}/servicebus/queues/${encodeURIComponent(queueName)}/deadletter/return/batch`, { method: 'POST', body: JSON.stringify(sequenceNumbers) });
export const returnSubscriptionDeadLetterBatch = (connectionId: number, topicName: string, subscriptionName: string, sequenceNumbers: number[]) =>
  fetchApi<{ processed: number }>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/subscriptions/${encodeURIComponent(subscriptionName)}/deadletter/return/batch`, { method: 'POST', body: JSON.stringify(sequenceNumbers) });

export const receiveQueueDeadLetterBatch = (connectionId: number, queueName: string, sequenceNumbers: number[]) =>
  fetchApi<{ processed: number }>(`/connections/${connectionId}/servicebus/queues/${encodeURIComponent(queueName)}/deadletter/receive/batch`, { method: 'POST', body: JSON.stringify(sequenceNumbers) });
export const receiveSubscriptionDeadLetterBatch = (connectionId: number, topicName: string, subscriptionName: string, sequenceNumbers: number[]) =>
  fetchApi<{ processed: number }>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/subscriptions/${encodeURIComponent(subscriptionName)}/deadletter/receive/batch`, { method: 'POST', body: JSON.stringify(sequenceNumbers) });

// Delete selected active messages (receive + complete by sequence number)
export const deleteQueueMessagesBatch = (connectionId: number, queueName: string, sequenceNumbers: number[]) =>
  fetchApi<{ processed: number }>(`/connections/${connectionId}/servicebus/queues/${encodeURIComponent(queueName)}/messages/delete/batch`, { method: 'POST', body: JSON.stringify(sequenceNumbers) });
export const deleteSubscriptionMessagesBatch = (connectionId: number, topicName: string, subscriptionName: string, sequenceNumbers: number[]) =>
  fetchApi<{ processed: number }>(`/connections/${connectionId}/servicebus/topics/${encodeURIComponent(topicName)}/subscriptions/${encodeURIComponent(subscriptionName)}/messages/delete/batch`, { method: 'POST', body: JSON.stringify(sequenceNumbers) });

// Cancel selected scheduled messages (by scheduled sequence number)
export const cancelQueueScheduledBatch = (connectionId: number, queueName: string, sequenceNumbers: number[]) =>
  fetchApi<{ processed: number }>(`/connections/${connectionId}/servicebus/queues/${encodeURIComponent(queueName)}/scheduled/cancel/batch`, { method: 'POST', body: JSON.stringify(sequenceNumbers) });

// Settings
export interface Settings {
  batchOperationTimeoutSeconds: number;
  mcpEnabled: boolean;
  // The configured MCP API key; empty string means no key (authorization not required).
  mcpApiKey: string;
  // Last completed tour guide version (0 = never shown).
  tourGuideCompletedStep: number;
}

export interface UpdateSettingsRequest {
  batchOperationTimeoutSeconds?: number;
  mcpEnabled?: boolean;
  // Key to store; omit to leave unchanged, or pass an empty string to clear it.
  mcpApiKey?: string;
  // Tour guide: pass the completed step to acknowledge it; omit to leave unchanged.
  tourGuideCompletedStep?: number;
}

export const getSettings = () => fetchApi<Settings>('/settings');
export const updateSettings = (settings: UpdateSettingsRequest) =>
  fetchApi<Settings>('/settings', { method: 'PUT', body: JSON.stringify(settings) });

// Message templates
export const getMessageTemplates = () => fetchApi<MessageTemplate[]>('/message-templates');
export const getMessageTemplate = (id: number) => fetchApi<MessageTemplate>(`/message-templates/${id}`);
export const saveMessageTemplate = (data: SaveMessageTemplateRequest) =>
  fetchApi<MessageTemplate>('/message-templates', { method: 'POST', body: JSON.stringify(data) });
export const deleteMessageTemplate = (id: number) =>
  fetchApi<void>(`/message-templates/${id}`, { method: 'DELETE' });

// Search history
export const getSearchHistory = (searchKey: string) =>
  fetchApi<SearchHistoryEntry[]>(`/search-history/${encodeURIComponent(searchKey)}`);
export const recordSearchHistory = (searchKey: string, term: string) =>
  fetchApi<SearchHistoryEntry>('/search-history', { method: 'POST', body: JSON.stringify({ searchKey, term }) });
export const setSearchHistoryFavorite = (searchKey: string, term: string, isFavorite: boolean) =>
  fetchApi<SearchHistoryEntry>('/search-history/favorite', { method: 'PUT', body: JSON.stringify({ searchKey, term, isFavorite }) });
export const deleteSearchHistory = (searchKey: string, term: string) =>
  fetchApi<void>(`/search-history?searchKey=${encodeURIComponent(searchKey)}&term=${encodeURIComponent(term)}`, { method: 'DELETE' });
