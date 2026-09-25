import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Eye, Send, RefreshCw, Trash2, RotateCcw, Inbox, MessageSquare, Users, Skull, X, ChevronLeft, Menu, Layers, Clock, Search, GripVertical, Star, History } from 'lucide-react';
import type { Connection, QueueInfo, TopicInfo, SelectedEntity, ServiceBusMessage, SessionInfo, SearchHistoryEntry } from '../types';
import { peekQueueMessages, peekSubscriptionMessages, receiveQueueMessages, receiveSubscriptionMessages, returnQueueDeadLetter, returnSubscriptionDeadLetter, returnQueueDeadLetterBatch, returnSubscriptionDeadLetterBatch, receiveQueueDeadLetterBatch, receiveSubscriptionDeadLetterBatch, deleteQueueMessagesBatch, deleteSubscriptionMessagesBatch, cancelQueueScheduledBatch, scanQueueSessions, scanSubscriptionSessions, peekQueueSessionMessages, peekSubscriptionSessionMessages, getSearchHistory, recordSearchHistory, setSearchHistoryFavorite, deleteSearchHistory } from '../api/client';
import MessageViewer from './MessageViewer';
import SendMessageDialog from './SendMessageDialog';
import { formatDateTime, useDateFormat } from '../utils/dateFormat';
import { formatMessageCount } from '../utils/messageCounts';
import DatePicker from './DatePicker';

const PANEL_RATIO_KEY = 'vectora_message_panel_ratio';
const MESSAGE_SEARCH_KEY = '1dc10436-8e90-454d-a3f2-6cc55124f270';

interface MessagePanelProps {
  connection: Connection | null;
  selectedEntity: SelectedEntity | null;
  queues: QueueInfo[];
  topics: TopicInfo[];
  onUpdateEntityCount?: (entity: SelectedEntity, recount?: boolean) => void;
  // Reports what the loaded message list proves about the entity's count: at least `loaded`
  // messages, and exactly `loaded` once the end of the entity has been reached.
  onMessagesLoaded?: (entity: SelectedEntity, loaded: number, reachedEnd: boolean, deadLetter: boolean) => void;
  isMobile?: boolean;
  onOpenSidebar?: () => void;
  // When set, the panel uses these messages instead of loading from the API
  // (used during the tour to show dummy data without a real connection).
  tourDummyMessages?: ServiceBusMessage[];
  // When set, forces the message-detail tab to this mode (used during the tour).
  tourForcedViewMode?: 'body' | 'properties';
}

// Case-insensitive substring match across a message's searchable fields, including its
// application properties. `q` must already be trimmed and lower-cased.
function messageMatchesSearch(m: ServiceBusMessage, q: string): boolean {
  const fields = [
    m.body,
    m.subject,
    m.messageId,
    m.correlationId,
    m.sessionId,
    m.to,
    m.replyTo,
    m.deadLetterReason,
    m.deadLetterErrorDescription,
    m.deadLetterSource,
    String(m.sequenceNumber),
  ];
  for (const f of fields) {
    if (f && f.toLowerCase().includes(q)) {
      return true;
    }
  }
  if (m.applicationProperties) {
    for (const [key, value] of Object.entries(m.applicationProperties)) {
      if (key.toLowerCase().includes(q)) {
        return true;
      }
      if (value != null && String(value).toLowerCase().includes(q)) {
        return true;
      }
    }
  }
  return false;
}

function sortSearchHistoryEntries(entries: SearchHistoryEntry[]) {
  return [...entries].sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;

    // Match backend ordering semantics (favorites: alpha, case-insensitive)
    if (a.isFavorite) return a.term.localeCompare(b.term, undefined, { sensitivity: 'base' });

    // Non-favorites: newest-first, with term tiebreaker (case-insensitive)
    const dateDiff = new Date(b.lastSearchedAt).getTime() - new Date(a.lastSearchedAt).getTime();
    if (dateDiff !== 0) return dateDiff;
    return a.term.localeCompare(b.term, undefined, { sensitivity: 'base' });
  });
}

export default function MessagePanel({ connection, selectedEntity, queues, topics, onUpdateEntityCount, onMessagesLoaded, isMobile = false, onOpenSidebar, tourDummyMessages, tourForcedViewMode }: MessagePanelProps) {
  useDateFormat(); // re-render session timestamps when the date format setting changes
  // Mobile view state: 'list' shows message list, 'detail' shows message detail
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [messages, setMessages] = useState<ServiceBusMessage[]>([]);
  const [selectedMessage, setSelectedMessage] = useState<ServiceBusMessage | null>(null);
  const [selectedMessages, setSelectedMessages] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [showDeadLetter, setShowDeadLetter] = useState(false);
  const [showSendDialog, setShowSendDialog] = useState(false);
  const [templateMessage, setTemplateMessage] = useState<ServiceBusMessage | null>(null);
  const [showConsumePopup, setShowConsumePopup] = useState(false);
  const [consumeCount, setConsumeCount] = useState('10');
  const [clearAll, setClearAll] = useState(false);
  // Transient feedback banner for consume/delete results (e.g. "Consumed 200 messages").
  const [actionStatus, setActionStatus] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [detailsTab, setDetailsTab] = useState<'body' | 'properties'>('body');
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const consumeSubmitInFlightRef = useRef(false);

  // Draggable splitter between the message list and the detail viewer (desktop only).
  // The ratio is the list panel's share of the container width, persisted across sessions.
  const [listPanelRatio, setListPanelRatio] = useState(() => {
    const saved = localStorage.getItem(PANEL_RATIO_KEY);
    return saved ? parseFloat(saved) : 0.5;
  });
  const [isResizingPanels, setIsResizingPanels] = useState(false);
  const panelsContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(PANEL_RATIO_KEY, listPanelRatio.toString());
  }, [listPanelRatio]);

  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingPanels(true);
  }, []);

  useEffect(() => {
    if (!isResizingPanels) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panelsContainerRef.current) return;
      const rect = panelsContainerRef.current.getBoundingClientRect();
      const newRatio = (e.clientX - rect.left) / rect.width;
      // Clamp between 20% and 80%
      setListPanelRatio(Math.min(0.8, Math.max(0.2, newRatio)));
    };
    const handleMouseUp = () => setIsResizingPanels(false);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingPanels]);

  // Client-side search over the flat message list. When a query is entered we keep peeking
  // pages until the entity is exhausted, then filter the already-loaded messages locally, so
  // the user can search without ever re-fetching. Peek-only, so it never locks/removes anything.
  // `searchInput` tracks the raw text box for instant typing; `searchQuery` is the debounced
  // value that actually drives filtering, so keystrokes don't re-filter/re-render a huge list.
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryEntry[]>([]);
  const [searchHistoryOpen, setSearchHistoryOpen] = useState(false);
  const [enqueuedFromDate, setEnqueuedFromDate] = useState<Date | null>(null);
  const [enqueuedToDate, setEnqueuedToDate] = useState<Date | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const loadAllRef = useRef(false);
  const loadAllRunIdRef = useRef(0);
  const messagesRef = useRef<ServiceBusMessage[]>([]);
  const hasMoreRef = useRef(true);
  // Bumped whenever the entity, connection, DLQ flag or session mode changes. Every load captures
  // it and discards its result if it no longer matches, so a peek that resolves after the user has
  // moved on can't append another entity's messages to this list or report its count. The emulator
  // makes this easy to hit: a single peek there occasionally stalls ~12s.
  const loadGenRef = useRef(0);
  const searchInputRef = useRef('');
  const searchHistoryContainerRef = useRef<HTMLDivElement>(null);
  const searchDeletingRef = useRef(false);
  // Client-side windowing: only render this many rows at a time and grow on scroll, so a huge
  // result set (e.g. thousands of matches) never builds thousands of DOM nodes at once.
  const [visibleCount, setVisibleCount] = useState(50);

  // Session view: browse messages grouped by session id. Everything here is peek-only
  // (read-only) and pages through the entity by sequence number, so it never locks a
  // session or disrupts live consumers.
  const [sessionView, setSessionView] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  const [sessionCursor, setSessionCursor] = useState<number | null>(null);
  const [sessionsReachedEnd, setSessionsReachedEnd] = useState(false);
  const [sessionScannedTotal, setSessionScannedTotal] = useState(0);
  // When a session is opened, its messages are loaded into `messages` for reuse of the
  // existing list/detail panes; these track that drill-in's own paging cursor.
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [sessionMsgLoading, setSessionMsgLoading] = useState(false);
  const [loadingMoreSessionMsgs, setLoadingMoreSessionMsgs] = useState(false);
  const [sessionMsgCursor, setSessionMsgCursor] = useState<number | null>(null);
  const [sessionMsgReachedEnd, setSessionMsgReachedEnd] = useState(false);
  const [sessionMsgScannedTotal, setSessionMsgScannedTotal] = useState(0);

  const PAGE_SIZE = 50;
  // How many additional rows to reveal each time the window grows (scroll / keyboard / button).
  const WINDOW_STEP = 300;
  const SESSION_SCAN_LIMIT = 1000;
  // Larger chunk used when eagerly draining the entity for a search (backend caps peek at 1000).
  const SEARCH_PAGE_SIZE = 500;
  const getEntityInfo = () => {
    if (!selectedEntity) return null;
    if (selectedEntity.type === 'queue') {
      return queues.find(q => q.name === selectedEntity.name);
    } else if (selectedEntity.type === 'subscription' && selectedEntity.topicName) {
      const topic = topics.find(t => t.name === selectedEntity.topicName);
      return topic?.subscriptions.find(s => s.name === selectedEntity.name);
    }
    return null;
  };

  const entityInfo = getEntityInfo();
  // Sessions only apply to session-enabled queues/subscriptions; topics are never selectable here.
  const isSessionEntity = !!entityInfo?.requiresSession;
  // True once a session has been opened and we're showing that session's messages.
  const inSessionMessages = sessionView && selectedSession !== null;
  // Any in-flight load, used for the header spinner/refresh state across all modes.
  const busy = loading || sessionsLoading || sessionMsgLoading;

  // Capture the entity and sub-queue at call time: by the time a load resolves the selection may
  // already have moved on, and reporting these counts against the new entity would be wrong.
  const reportLoaded = (gen: number, entity: SelectedEntity, deadLetter: boolean, loaded: number, reachedEnd: boolean) => {
    if (gen !== loadGenRef.current) return;
    if (sessionView || tourDummyMessages !== undefined) return;
    onMessagesLoaded?.(entity, loaded, reachedEnd, deadLetter);
  };

  const loadMessages = async () => {
    if (!connection || !selectedEntity) return;
    const entity = selectedEntity;
    const deadLetter = showDeadLetter;
    const gen = loadGenRef.current;
    setLoading(true);
    setHasMore(true);
    try {
      let msgs: ServiceBusMessage[];
      if (selectedEntity.type === 'queue') {
        msgs = await peekQueueMessages(connection.id, selectedEntity.name, PAGE_SIZE, showDeadLetter);
      } else if (selectedEntity.type === 'subscription' && selectedEntity.topicName) {
        msgs = await peekSubscriptionMessages(connection.id, selectedEntity.topicName, selectedEntity.name, PAGE_SIZE, showDeadLetter);
      } else {
        msgs = [];
      }
      if (gen !== loadGenRef.current) return;

      setMessages(msgs);
      setHasMore(msgs.length === PAGE_SIZE);
      reportLoaded(gen, entity, deadLetter, msgs.length, msgs.length < PAGE_SIZE);

      // A full first page means there may be more than we can see, so ask the server to browse the
      // entity for a sharper number. Deliberately not awaited: the messages are already on screen
      // and the count arrives whenever it arrives.
      if (msgs.length === PAGE_SIZE && connection.isEmulator) {
        onUpdateEntityCount?.(entity, true);
      }
      setSelectedMessage(null);
      setSelectedMessages(new Set());
    } catch (error) {
      console.error('Failed to load messages:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadSearchHistory = useCallback(async () => {
    try {
      const entries = await getSearchHistory(MESSAGE_SEARCH_KEY);
      setSearchHistory(sortSearchHistoryEntries(entries));
    } catch (error) {
      console.error('Failed to load message search history:', error);
    }
  }, []);

  const saveSearchTerm = useCallback(async (term: string) => {
    const trimmed = term.trim();
    if (!trimmed) return;
    try {
      await recordSearchHistory(MESSAGE_SEARCH_KEY, trimmed);
      await loadSearchHistory();
    } catch (error) {
      console.error('Failed to save message search history:', error);
    }
  }, [loadSearchHistory]);

  const toggleSearchFavorite = useCallback(async (term: string, isFavorite: boolean) => {
    try {
      await setSearchHistoryFavorite(MESSAGE_SEARCH_KEY, term, isFavorite);
      setSearchHistory(prev => sortSearchHistoryEntries(prev.map(entry =>
        entry.term === term
          ? { ...entry, isFavorite, lastSearchedAt: new Date().toISOString() }
          : entry)));
    } catch (error) {
      console.error('Failed to update message search favorite:', error);
    }
  }, []);

  const deleteHistoryEntry = useCallback(async (term: string) => {
    try {
      await deleteSearchHistory(MESSAGE_SEARCH_KEY, term);
      setSearchHistory(prev => prev.filter(entry => entry.term !== term));
    } catch (error) {
      console.error('Failed to delete message search history entry:', error);
    }
  }, []);

  const loadMoreMessages = async () => {
    if (!connection || !selectedEntity || loadingMore || loadingAll || !hasMore || messages.length === 0) return;
    if (tourDummyMessages !== undefined) return; // tour mode: no more pages to load
    const entity = selectedEntity;
    const deadLetter = showDeadLetter;
    const gen = loadGenRef.current;
    setLoadingMore(true);
    try {
      const lastSequenceNumber = messages[messages.length - 1].sequenceNumber;
      let moreMsgs: ServiceBusMessage[];
      if (selectedEntity.type === 'queue') {
        moreMsgs = await peekQueueMessages(connection.id, selectedEntity.name, PAGE_SIZE, showDeadLetter, lastSequenceNumber + 1);
      } else if (selectedEntity.type === 'subscription' && selectedEntity.topicName) {
        moreMsgs = await peekSubscriptionMessages(connection.id, selectedEntity.topicName, selectedEntity.name, PAGE_SIZE, showDeadLetter, lastSequenceNumber + 1);
      } else {
        moreMsgs = [];
      }
      if (gen !== loadGenRef.current) return;

      if (moreMsgs.length > 0) {
        setMessages(prev => [...prev, ...moreMsgs]);
      }
      setHasMore(moreMsgs.length === PAGE_SIZE);
      reportLoaded(gen, entity, deadLetter, messages.length + moreMsgs.length, moreMsgs.length < PAGE_SIZE);
    } catch (error) {
      console.error('Failed to load more messages:', error);
    } finally {
      setLoadingMore(false);
    }
  };

  // Keep refs in sync so the search drain loop can read the latest list/hasMore without
  // being recreated on every append.
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { hasMoreRef.current = hasMore; }, [hasMore]);

  // Eagerly peek pages until the entity is drained, so a client-side search covers every
  // message. Guarded by a ref so scroll paging / repeated triggers can't run it concurrently.
  const loadAllRemaining = useCallback(async () => {
    if (!connection || !selectedEntity || loadAllRef.current) return;
    if (tourDummyMessages !== undefined) return; // tour mode: messages are already complete
    const entity = selectedEntity;
    const deadLetter = showDeadLetter;
    const gen = loadGenRef.current;
    const runId = ++loadAllRunIdRef.current;
    loadAllRef.current = true;
    setLoadingAll(true);
    try {
      let current = messagesRef.current;
      let more = hasMoreRef.current;
      while (more && loadAllRunIdRef.current === runId && gen === loadGenRef.current) {
        const last = current.length > 0 ? current[current.length - 1].sequenceNumber : undefined;
        const from = last != null ? last + 1 : undefined;
        let batch: ServiceBusMessage[];
        if (selectedEntity.type === 'queue') {
          batch = await peekQueueMessages(connection.id, selectedEntity.name, SEARCH_PAGE_SIZE, showDeadLetter, from);
        } else if (selectedEntity.type === 'subscription' && selectedEntity.topicName) {
          batch = await peekSubscriptionMessages(connection.id, selectedEntity.topicName, selectedEntity.name, SEARCH_PAGE_SIZE, showDeadLetter, from);
        } else {
          break;
        }
        if (loadAllRunIdRef.current !== runId || gen !== loadGenRef.current) break;
        if (batch.length > 0) {
          current = [...current, ...batch];
          setMessages(current);
        }
        more = batch.length === SEARCH_PAGE_SIZE;
        setHasMore(more);
        // The search drain scans the whole entity, so its running total is a real count.
        reportLoaded(gen, entity, deadLetter, current.length, !more);
      }
    } catch (error) {
      console.error('Failed to load all messages for search:', error);
    } finally {
      if (loadAllRunIdRef.current === runId) {
        loadAllRef.current = false;
        setLoadingAll(false);
      }
    }
  }, [connection, selectedEntity, showDeadLetter]);

  // Debounce the raw text box into the query that drives filtering/draining, so typing stays
  // responsive even with tens of thousands of loaded messages.
  useEffect(() => {
    if (searchInput === searchQuery) return;
    const timer = setTimeout(() => setSearchQuery(searchInput), 200);
    return () => clearTimeout(timer);
  }, [searchInput, searchQuery]);

  useEffect(() => {
    const trimmed = searchInput.trim();
    if (!trimmed) return;
    const timer = setTimeout(() => {
      saveSearchTerm(trimmed);
    }, 10000);
    return () => clearTimeout(timer);
  }, [searchInput, saveSearchTerm]);

  useEffect(() => {
    if (!searchHistoryOpen) return;
    loadSearchHistory();
  }, [searchHistoryOpen, loadSearchHistory]);

  useEffect(() => {
    if (!searchHistoryOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!searchHistoryContainerRef.current?.contains(event.target as Node)) {
        setSearchHistoryOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [searchHistoryOpen]);

  useEffect(() => {
    if (!searchHistoryOpen) return;
    const closeHistory = () => setSearchHistoryOpen(false);
    window.addEventListener('blur', closeHistory);
    document.addEventListener('visibilitychange', closeHistory);
    return () => {
      window.removeEventListener('blur', closeHistory);
      document.removeEventListener('visibilitychange', closeHistory);
    };
  }, [searchHistoryOpen]);

  useEffect(() => {
    if (searchHistoryOpen && (showSendDialog || showConsumePopup)) {
      setSearchHistoryOpen(false);
    }
  }, [searchHistoryOpen, showSendDialog, showConsumePopup]);

  const handleSearchInputChange = (value: string) => {
    setSearchHistoryOpen(false);
    if (value.length < searchInput.length) {
      if (!searchDeletingRef.current) {
        saveSearchTerm(searchInput);
      }
      searchDeletingRef.current = true;
    } else {
      searchDeletingRef.current = false;
    }
    setSearchInput(value);
  };

  useEffect(() => {
    searchInputRef.current = searchInput;
  }, [searchInput]);

  useEffect(() => {
    return () => {
      const trimmed = searchInputRef.current.trim();
      if (trimmed) {
        void saveSearchTerm(trimmed);
      }
    };
  }, [saveSearchTerm]);

  const hasActiveFilters = !!searchQuery.trim() || enqueuedFromDate !== null || enqueuedToDate !== null;

  // When a filter is active and the flat list isn't fully loaded, drain the rest so
  // filtering runs against the whole entity.
  useEffect(() => {
    if (hasActiveFilters && hasMore && !sessionView && !loadAllRef.current) {
      loadAllRemaining();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActiveFilters, hasMore, sessionView]);

  // Messages shown in the flat list, narrowed by the current filters.
  const filteredMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const from = enqueuedFromDate
      ? new Date(enqueuedFromDate.getFullYear(), enqueuedFromDate.getMonth(), enqueuedFromDate.getDate(), 0, 0, 0, 0).getTime()
      : Number.NEGATIVE_INFINITY;
    const to = enqueuedToDate
      ? new Date(enqueuedToDate.getFullYear(), enqueuedToDate.getMonth(), enqueuedToDate.getDate(), 23, 59, 59, 999).getTime()
      : Number.POSITIVE_INFINITY;

    if (!q && !enqueuedFromDate && !enqueuedToDate) return messages;

    return messages.filter(m => {
      if (q && !messageMatchesSearch(m, q)) return false;

      const enqueuedTime = Date.parse(m.enqueuedTime);
      if ((enqueuedFromDate || enqueuedToDate) && Number.isNaN(enqueuedTime)) {
        return false;
      }
      if (!Number.isNaN(enqueuedTime) && (enqueuedTime < from || enqueuedTime > to)) {
        return false;
      }

      return true;
    });
  }, [messages, searchQuery, enqueuedFromDate, enqueuedToDate]);

  // The flat list uses the filtered view; a drilled-in session reuses `messages` untouched.
  const listMessages = inSessionMessages ? messages : filteredMessages;

  // Only the first `visibleCount` rows are actually rendered; scrolling grows the window.
  const visibleMessages = useMemo(() => listMessages.slice(0, visibleCount), [listMessages, visibleCount]);
  const hasHiddenRows = visibleCount < listMessages.length;

  // Collapse the window back to one page whenever the result set is conceptually replaced
  // (new query, entity, DLQ toggle, or session context) so we never start by rendering a
  // stale, huge slice. Streaming appends during a drain keep the user's grown window intact.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [searchQuery, enqueuedFromDate, enqueuedToDate, connection, selectedEntity, showDeadLetter, sessionView, selectedSession]);


  // Peek one page of messages and fold the per-session counts into the running list.
  // `reset` starts a fresh scan; otherwise it continues from the last sequence number.
  const scanSessions = async (reset: boolean) => {
    if (!connection || !selectedEntity) return;
    if (reset) {
      setSessionsLoading(true);
      setSessions([]);
      setSessionScannedTotal(0);
      setSessionsReachedEnd(false);
      setSessionCursor(null);
    } else {
      setLoadingMoreSessions(true);
    }
    try {
      const from = reset ? undefined : (sessionCursor != null ? sessionCursor + 1 : undefined);
      const result = selectedEntity.type === 'queue'
        ? await scanQueueSessions(connection.id, selectedEntity.name, showDeadLetter, from, SESSION_SCAN_LIMIT)
        : selectedEntity.type === 'subscription' && selectedEntity.topicName
          ? await scanSubscriptionSessions(connection.id, selectedEntity.topicName, selectedEntity.name, showDeadLetter, from, SESSION_SCAN_LIMIT)
          : null;
      if (!result) return;
      setSessions(prev => mergeSessions(reset ? [] : prev, result.sessions));
      setSessionScannedTotal(prev => (reset ? 0 : prev) + result.scannedCount);
      setSessionsReachedEnd(result.reachedEnd);
      setSessionCursor(result.lastSequenceNumber);
    } catch (error) {
      console.error('Failed to scan sessions:', error);
    } finally {
      setSessionsLoading(false);
      setLoadingMoreSessions(false);
    }
  };

  // Peek a page and keep only the chosen session's messages, paging the same way.
  const loadSessionMessages = async (sessionId: string, reset: boolean) => {
    if (!connection || !selectedEntity) return;
    if (reset) {
      setSessionMsgLoading(true);
      setMessages([]);
      setSelectedMessage(null);
      setSessionMsgScannedTotal(0);
      setSessionMsgReachedEnd(false);
      setSessionMsgCursor(null);
    } else {
      setLoadingMoreSessionMsgs(true);
    }
    try {
      const from = reset ? undefined : (sessionMsgCursor != null ? sessionMsgCursor + 1 : undefined);
      const result = selectedEntity.type === 'queue'
        ? await peekQueueSessionMessages(connection.id, selectedEntity.name, sessionId, showDeadLetter, from, SESSION_SCAN_LIMIT)
        : selectedEntity.type === 'subscription' && selectedEntity.topicName
          ? await peekSubscriptionSessionMessages(connection.id, selectedEntity.topicName, selectedEntity.name, sessionId, showDeadLetter, from, SESSION_SCAN_LIMIT)
          : null;
      if (!result) return;
      setMessages(prev => reset ? result.messages : [...prev, ...result.messages]);
      setSessionMsgScannedTotal(prev => (reset ? 0 : prev) + result.scannedCount);
      setSessionMsgReachedEnd(result.reachedEnd);
      setSessionMsgCursor(result.lastSequenceNumber);
    } catch (error) {
      console.error('Failed to load session messages:', error);
    } finally {
      setSessionMsgLoading(false);
      setLoadingMoreSessionMsgs(false);
    }
  };

  const openSession = (sessionId: string) => {
    setSelectedSession(sessionId);
    if (isMobile) setMobileView('list');
    loadSessionMessages(sessionId, true);
  };

  const backToSessions = () => {
    setSelectedSession(null);
    setMessages([]);
    setSelectedMessage(null);
  };

  // Toggle the session list on/off; turning it off returns to the flat message list.
  const toggleSessionView = () => {
    setSelectedSession(null);
    setSessionView(v => !v);
  };

  const handleRefresh = () => {
    refreshAfterAction();
  };

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    if (scrollHeight - scrollTop - clientHeight >= 200) return;

    // Reveal more already-loaded rows first (client-side windowing).
    if (hasHiddenRows) {
      setVisibleCount(c => Math.min(listMessages.length, c + WINDOW_STEP));
      return;
    }
    // Everything loaded is now shown; in non-search mode fetch the next server page.
    if (!hasActiveFilters && !loadingMore && !loadingAll && hasMore) {
      loadMoreMessages();
    }
  }, [hasHiddenRows, listMessages.length, hasActiveFilters, loadingMore, loadingAll, hasMore]);

  useEffect(() => {
    // Any change to the entity, connection, DLQ flag, or session toggle drops back to the
    // session list (if in session view) or the flat message list, and clears selections.
    const pendingSearchTerm = searchInputRef.current.trim();
    if (pendingSearchTerm) {
      void saveSearchTerm(pendingSearchTerm);
    }
    loadAllRunIdRef.current += 1;
    loadGenRef.current += 1;
    loadAllRef.current = false;
    setLoadingAll(false);
    // Drop the outgoing entity's messages straight away. Leaving them in place let the
    // load-more path continue the *previous* entity's list against the newly selected one.
    // The refs are cleared synchronously too: they are normally synced by an effect, so the
    // search drain could otherwise start from the previous entity's list.
    setMessages([]);
    setHasMore(true);
    messagesRef.current = [];
    hasMoreRef.current = true;
    setSelectedSession(null);
    setSelectedMessage(null);
    setSelectedMessages(new Set());
    setSearchHistoryOpen(false);
    setSearchInput('');
    setSearchQuery('');
    setEnqueuedFromDate(null);
    setEnqueuedToDate(null);
    if (!connection || !selectedEntity) {
      setMessages([]);
      setSessions([]);
      return;
    }
    // Tour mode: use static dummy messages, no API calls.
    if (tourDummyMessages !== undefined) {
      setMessages(tourDummyMessages);
      setSelectedMessage(tourDummyMessages[0] ?? null);
      setHasMore(false);
      return;
    }
    if (sessionView && !isSessionEntity) {
      // Selected a non-session entity while session view was on — fall back to messages.
      setSessionView(false);
      return;
    }
    if (sessionView) {
      scanSessions(true);
    } else {
      loadMessages();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, selectedEntity, showDeadLetter, sessionView, isSessionEntity, tourDummyMessages]);

  // Keyboard navigation for message list
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if not in select mode and we have messages
      if (selectMode || visibleMessages.length === 0) return;

      // Don't handle if focus is in an input, textarea, or the editor
      const activeElement = document.activeElement;
      if (activeElement?.tagName === 'INPUT' || activeElement?.tagName === 'TEXTAREA' ||
          activeElement?.closest('.monaco-editor')) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();

        const currentIndex = selectedMessage
          ? visibleMessages.findIndex(m => m.sequenceNumber === selectedMessage.sequenceNumber)
          : -1;

        // At the bottom of the rendered window with more rows available, reveal the next page.
        if (e.key === 'ArrowDown' && currentIndex === visibleMessages.length - 1 && hasHiddenRows) {
          setVisibleCount(c => Math.min(listMessages.length, c + WINDOW_STEP));
          return;
        }

        let newIndex: number;
        if (e.key === 'ArrowDown') {
          newIndex = currentIndex < visibleMessages.length - 1 ? currentIndex + 1 : currentIndex;
        } else {
          newIndex = currentIndex > 0 ? currentIndex - 1 : (currentIndex === -1 ? 0 : currentIndex);
        }

        if (newIndex !== currentIndex && newIndex >= 0 && newIndex < visibleMessages.length) {
          setSelectedMessage(visibleMessages[newIndex]);

          // Scroll the message into view
          const messageElements = scrollContainerRef.current?.querySelectorAll('[data-message-item]');
          if (messageElements && messageElements[newIndex]) {
            messageElements[newIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visibleMessages, selectedMessage, selectMode, hasHiddenRows, listMessages.length]);

  const refreshAfterAction = async () => {
    // Session view has its own peek-based loaders; loadMessages() would fetch the flat list.
    if (sessionView) {
      if (selectedSession) {
        await loadSessionMessages(selectedSession, true);
      } else {
        await scanSessions(true);
      }
    } else {
      await loadMessages();
    }
    if (selectedEntity) {
      onUpdateEntityCount?.(selectedEntity);
    }
  };

  const closeConsumePopup = () => {
    setShowConsumePopup(false);
    setConsumeCount('10');
    setClearAll(false);
  };

  // Close popups on Escape
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (showConsumePopup) closeConsumePopup();
    }
  }, [showConsumePopup]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Auto-dismiss the action status banner. Errors linger longer than successes.
  useEffect(() => {
    if (!actionStatus) return;
    const timer = setTimeout(() => setActionStatus(null), actionStatus.kind === 'error' ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [actionStatus]);

  const handleConsumeSubmit = async () => {
    if (!connection || !selectedEntity) return;
    if (consumeSubmitInFlightRef.current) return;
    const count = clearAll ? 10000 : parseInt(consumeCount) || 0;
    if (count <= 0) return;
    // Drilled into a session: consume only that session, leaving the other sessions untouched.
    const sessionId = inSessionMessages ? selectedSession ?? undefined : undefined;
    consumeSubmitInFlightRef.current = true;
    setLoading(true);
    setActionStatus(null);
    closeConsumePopup();
    try {
      let result: { consumedCount: number } | undefined;
      if (selectedEntity.type === 'queue') {
        result = await receiveQueueMessages(connection.id, selectedEntity.name, count, showDeadLetter, sessionId);
      } else if (selectedEntity.type === 'subscription' && selectedEntity.topicName) {
        result = await receiveSubscriptionMessages(connection.id, selectedEntity.topicName, selectedEntity.name, count, showDeadLetter, sessionId);
      }
      await refreshAfterAction();
      const consumed = result?.consumedCount ?? 0;
      const scope = sessionId !== undefined ? ` from session "${sessionId}"` : '';
      // Report the exact number removed so a partial consume (fewer available, or a cancelled
      // long run) is visible rather than silent.
      setActionStatus({
        kind: 'success',
        text: clearAll
          ? `Consumed ${consumed} message${consumed === 1 ? '' : 's'}${scope}.`
          : `Consumed ${consumed} of ${count} requested message${count === 1 ? '' : 's'}${scope}.`,
      });
    } catch (error) {
      console.error('Failed to receive messages:', error);
      const message = error instanceof Error ? error.message : 'Failed to consume messages.';
      setActionStatus({ kind: 'error', text: message });
    } finally {
      consumeSubmitInFlightRef.current = false;
      setLoading(false);
    }
  };

  const handleConsumeSelected = async () => {
    if (!connection || !selectedEntity || selectedMessages.size === 0) return;
    setLoading(true);
    try {
      const sequenceNumbers = Array.from(selectedMessages);
      if (selectedEntity.type === 'queue') {
        await receiveQueueDeadLetterBatch(connection.id, selectedEntity.name, sequenceNumbers);
      } else if (selectedEntity.type === 'subscription' && selectedEntity.topicName) {
        await receiveSubscriptionDeadLetterBatch(connection.id, selectedEntity.topicName, selectedEntity.name, sequenceNumbers);
      }
      setSelectedMessages(new Set());
      setSelectMode(false);
      await refreshAfterAction();
    } catch (error) {
      console.error('Failed to consume selected messages:', error);
    } finally {
      setLoading(false);
    }
  };

  // Delete the selected active-queue messages. Scheduled messages can't be received, so they
  // are cancelled by their scheduled sequence number; everything else is received + completed.
  const handleDeleteSelected = async () => {
    if (!connection || !selectedEntity || selectedMessages.size === 0) return;
    setLoading(true);
    try {
      const selected = messages.filter(m => selectedMessages.has(m.sequenceNumber));
      const scheduled = selected.filter(m => m.state === 'Scheduled').map(m => m.sequenceNumber);
      const active = selected.filter(m => m.state !== 'Scheduled').map(m => m.sequenceNumber);

      if (selectedEntity.type === 'queue') {
        if (scheduled.length > 0) await cancelQueueScheduledBatch(connection.id, selectedEntity.name, scheduled);
        if (active.length > 0) await deleteQueueMessagesBatch(connection.id, selectedEntity.name, active);
      } else if (selectedEntity.type === 'subscription' && selectedEntity.topicName) {
        // Subscriptions never hold scheduled messages (scheduling targets the topic).
        if (active.length > 0) await deleteSubscriptionMessagesBatch(connection.id, selectedEntity.topicName, selectedEntity.name, active);
      }
      setSelectedMessages(new Set());
      setSelectMode(false);
      await refreshAfterAction();
    } catch (error) {
      console.error('Failed to delete selected messages:', error);
    } finally {
      setLoading(false);
    }
  };

  const toggleMessageSelection = (seqNum: number) => {
    setSelectedMessages(prev => {
      const next = new Set(prev);
      if (next.has(seqNum)) {
        next.delete(seqNum);
      } else {
        next.add(seqNum);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedMessages.size === filteredMessages.length) {
      setSelectedMessages(new Set());
    } else {
      setSelectedMessages(new Set(filteredMessages.map(m => m.sequenceNumber)));
    }
  };

  const toggleSelectMode = () => {
    if (selectMode) {
      // Exiting select mode - clear selections
      setSelectedMessages(new Set());
    }
    setSelectMode(!selectMode);
  };

  const handleReturnToQueue = async (msg: ServiceBusMessage) => {
    if (!connection || !selectedEntity || !showDeadLetter) return;
    setLoading(true);
    try {
      if (selectedEntity.type === 'queue') {
        await returnQueueDeadLetter(connection.id, selectedEntity.name, msg.sequenceNumber);
      } else if (selectedEntity.type === 'subscription' && selectedEntity.topicName) {
        await returnSubscriptionDeadLetter(connection.id, selectedEntity.topicName, selectedEntity.name, msg.sequenceNumber);
      }
      await refreshAfterAction();
    } catch (error) {
      console.error('Failed to return message:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleReturnSelectedToQueue = async () => {
    if (!connection || !selectedEntity || selectedMessages.size === 0 || !showDeadLetter) return;
    setLoading(true);
    try {
      const sequenceNumbers = [...selectedMessages];
      if (selectedEntity.type === 'queue') {
        await returnQueueDeadLetterBatch(connection.id, selectedEntity.name, sequenceNumbers);
      } else if (selectedEntity.type === 'subscription' && selectedEntity.topicName) {
        await returnSubscriptionDeadLetterBatch(connection.id, selectedEntity.topicName, selectedEntity.name, sequenceNumbers);
      }
      setSelectMode(false);
      setSelectedMessages(new Set());
      await refreshAfterAction();
    } catch (error) {
      console.error('Failed to return messages:', error);
    } finally {
      setLoading(false);
    }
  };

  const getEntityIcon = () => {
    if (!selectedEntity) return null;
    switch (selectedEntity.type) {
      case 'queue': return <Inbox className="w-5 h-5" />;
      case 'topic': return <MessageSquare className="w-5 h-5" />;
      case 'subscription': return <Users className="w-5 h-5" />;
    }
  };

  // Precompute the message rows for the visible window only. Deliberately excludes
  // `searchInput` from the deps so typing (which only updates the text box) never rebuilds
  // rows; windowing keeps this to ~one page regardless of how many messages match.
  const messageItems = useMemo(() => visibleMessages.map(msg => (
    <MessageListItem
      key={msg.sequenceNumber}
      message={msg}
      isSelected={selectedMessage?.sequenceNumber === msg.sequenceNumber}
      isChecked={selectedMessages.has(msg.sequenceNumber)}
      selectMode={!inSessionMessages && selectMode}
      onClick={() => {
        if (!inSessionMessages && selectMode) {
          toggleMessageSelection(msg.sequenceNumber);
        } else {
          setSelectedMessage(msg);
          if (isMobile) setMobileView('detail');
        }
      }}
      showDeadLetter={!inSessionMessages && showDeadLetter}
      onReturn={() => handleReturnToQueue(msg)}
    />
    // eslint-disable-next-line react-hooks/exhaustive-deps
  )), [visibleMessages, selectedMessage, selectedMessages, selectMode, inSessionMessages, showDeadLetter, isMobile]);

  if (!connection || !selectedEntity) {
    return (
      <div className="h-full flex items-center justify-center text-dark-500 p-4">
        <div className="text-center">
          {isMobile && (
            <button
              onClick={onOpenSidebar}
              className="mb-4 px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg text-dark-300 hover:text-white hover:border-dark-500 transition-colors flex items-center gap-2 mx-auto"
            >
              <Menu className="w-4 h-4" />
              Open Entity Browser
            </button>
          )}
          <Eye className="w-12 h-12 md:w-16 md:h-16 mx-auto mb-4 opacity-50" />
          <p className="text-base md:text-lg">Select an entity to view messages</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      {/* Death gradient overlay - subtle horror vibe */}
      <div
        className={`absolute inset-0 pointer-events-none transition-opacity duration-500 ${
          showDeadLetter ? 'opacity-100' : 'opacity-0'
        }`}
        style={{
          background: 'linear-gradient(180deg, rgba(80, 20, 20, 0.2) 0%, rgba(60, 15, 15, 0.08) 35%, transparent 65%)',
        }}
      />
      {/* Top edge glow */}
      <div
        className={`absolute top-0 left-0 right-0 h-px transition-opacity duration-500 ${
          showDeadLetter ? 'opacity-100' : 'opacity-0'
        }`}
        style={{
          background: 'linear-gradient(90deg, transparent, rgba(180, 30, 30, 0.4), transparent)',
          boxShadow: '0 0 15px 2px rgba(150, 25, 25, 0.25)',
        }}
      />

      {/* Header - responsive layout */}
      <div className={`px-3 md:px-4 py-2 md:py-0 md:h-[73px] ${busy ? '' : 'border-b border-dark-700'} flex flex-col md:flex-row md:items-center md:justify-between relative z-10 gap-2 md:gap-0`}>
        {/* Loading wave replaces the border line */}
        {busy && (
          <div className="absolute bottom-0 left-0 right-0 h-[1px] overflow-hidden bg-dark-700">
            <div className="loading-wave-line h-full w-full">
              <div className="wave-sweep h-full w-full bg-gradient-to-r from-transparent via-primary-400 to-transparent" />
            </div>
          </div>
        )}
        {/* Top row: Entity info + primary actions */}
        <div className="flex items-center gap-2 md:gap-3 flex-wrap">
          {/* Mobile back button */}
          {isMobile && mobileView === 'detail' && (
            <button
              onClick={() => setMobileView('list')}
              className="p-1.5 -ml-1 text-dark-400 hover:text-white transition-colors"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}
          <div className={`transition-colors duration-300 ${showDeadLetter ? 'text-red-400' : 'text-primary-400'}`}>{getEntityIcon()}</div>
          <div className="min-w-0 flex-shrink">
            <h2 className="font-semibold text-white text-sm md:text-base truncate">{selectedEntity.name}</h2>
            {selectedEntity.topicName && <p className="text-xs md:text-sm text-dark-400 truncate">Topic: {selectedEntity.topicName}</p>}
            <p className={`text-xs font-medium transition-all duration-300 overflow-hidden ${
              showDeadLetter ? 'text-red-400/80 max-h-6 opacity-100 mt-0.5' : 'max-h-0 opacity-0'
            }`}>Dead Letter Queue</p>
          </div>
          {/* Message counts */}
          {entityInfo && 'activeMessageCount' in entityInfo && (
            <div className="flex items-center gap-1 sm:gap-2 ml-1 md:ml-4 flex-shrink-0">
              <span className="text-[11px] sm:text-xs bg-dark-600 px-2 py-1 rounded whitespace-nowrap">
                <span className="sm:hidden">A: {formatMessageCount({ count: entityInfo.activeMessageCount, isExact: entityInfo.activeCountExact ?? true })}</span>
                <span className="hidden sm:inline">Active: {formatMessageCount({ count: entityInfo.activeMessageCount, isExact: entityInfo.activeCountExact ?? true })}</span>
              </span>
              <span className={`text-xs px-2 py-1 rounded ${entityInfo.deadLetterMessageCount > 0 ? 'bg-red-500/20 text-red-400' : 'bg-red-500/10 text-red-300'}`}>
                DLQ: {formatMessageCount({ count: entityInfo.deadLetterMessageCount, isExact: entityInfo.deadLetterCountExact ?? true })}
              </span>
            </div>
          )}
          {/* Refresh button */}
          <button onClick={handleRefresh} disabled={busy} className="flex items-center gap-1.5 ml-1 md:ml-3 px-2 md:px-3 py-1.5 bg-dark-600 hover:bg-dark-500 text-dark-300 hover:text-white text-sm rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap flex-shrink-0">
            <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
            <span className="hidden md:inline">Refresh</span>
          </button>
          {/* Sessions Toggle - only for session-enabled entities */}
          {isSessionEntity && (
            <button
              onClick={toggleSessionView}
              className={`flex items-center gap-1.5 px-2 md:px-3 py-1.5 text-sm rounded-lg transition-colors whitespace-nowrap flex-shrink-0 ${
                sessionView
                  ? 'bg-primary-500/20 text-primary-400 hover:bg-primary-500/30'
                  : 'bg-dark-600 hover:bg-dark-500 text-dark-300 hover:text-white'
              }`}
              title={sessionView ? 'Show flat message list' : 'Group messages by session'}
            >
              {sessionView ? (
                <>
                  <Inbox className="w-4 h-4" />
                  <span className="hidden md:inline">Messages</span>
                </>
              ) : (
                <>
                  <Layers className="w-4 h-4" />
                  <span className="hidden md:inline">Sessions</span>
                </>
              )}
            </button>
          )}
          {/* DLQ Toggle Button */}
          <button
            data-tour="dlq-button"
            onClick={() => setShowDeadLetter(!showDeadLetter)}
            className={`flex items-center gap-1.5 px-2 md:px-3 py-1.5 text-sm rounded-lg transition-colors whitespace-nowrap flex-shrink-0 ${
              showDeadLetter
                ? 'bg-primary-500/20 text-primary-400 hover:bg-primary-500/30'
                : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
            }`}
          >
            {showDeadLetter ? (
              <>
                <Inbox className="w-4 h-4" />
                <span className="hidden md:inline">Switch to Queue</span>
              </>
            ) : (
              <>
                <Skull className="w-4 h-4" />
                <span className="hidden md:inline">Switch to DLQ</span>
              </>
            )}
          </button>
        </div>
        {/* Action buttons - scrollable on mobile */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 md:pb-0 -mx-3 px-3 md:mx-0 md:px-0">
          {selectedEntity.type !== 'subscription' && (
            <button data-tour="send-button" onClick={() => setShowSendDialog(true)} className="flex items-center gap-1.5 px-2 md:px-3 py-1.5 bg-primary-500 hover:bg-primary-400 text-white text-sm rounded-lg whitespace-nowrap flex-shrink-0">
              <Send className="w-4 h-4" />
              <span className="hidden sm:inline">Send</span>
            </button>
          )}
          {/* Mutating actions are hidden in the session list, which is browse-only; consuming a
              single session is offered once the user has drilled into one. */}
          {!sessionView && showDeadLetter && selectedMessages.size > 0 && (
            <button onClick={handleReturnSelectedToQueue} disabled={loading} className="flex items-center gap-1.5 px-2 md:px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-400 text-sm rounded-lg disabled:opacity-50 whitespace-nowrap flex-shrink-0">
              <RotateCcw className="w-4 h-4" />
              <span className="hidden sm:inline">Return</span> ({selectedMessages.size})
            </button>
          )}
          {(!sessionView || inSessionMessages) && (!sessionView && selectedMessages.size > 0 ? (
            // Selected messages: DLQ "Consumes" them; the active queue "Deletes" them
            // (cancelling scheduled ones, receiving + completing the rest).
            <button
              onClick={showDeadLetter ? handleConsumeSelected : handleDeleteSelected}
              disabled={loading}
              className="flex items-center gap-1.5 px-2 md:px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 text-sm rounded-lg disabled:opacity-50 whitespace-nowrap flex-shrink-0"
            >
              <Trash2 className="w-4 h-4" />
              <span className="hidden sm:inline">{showDeadLetter ? 'Consume' : 'Delete'}</span> ({selectedMessages.size})
            </button>
          ) : (
            <button
              data-tour="consume-button"
              onClick={() => setShowConsumePopup(true)}
              disabled={loading || messages.length === 0}
              className="flex items-center gap-1.5 px-2 md:px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 text-sm rounded-lg disabled:opacity-50 whitespace-nowrap flex-shrink-0"
            >
              <Trash2 className="w-4 h-4" />
              <span className="hidden sm:inline">Consume</span>
            </button>
          ))}

        </div>
      </div>

      {/* Content - stacked on mobile, side-by-side on desktop */}
      <div ref={panelsContainerRef} className={`flex-1 flex flex-col md:flex-row overflow-hidden min-h-0 relative z-10 ${isResizingPanels ? 'select-none' : ''}`}>
        {/* Message List - full width on mobile when in list view */}
        <div
          className={`
            ${isMobile
              ? mobileView === 'list' ? 'flex-1' : 'hidden'
              : 'flex-none'
            }
            flex flex-col min-h-0 min-w-0
          `}
          style={isMobile ? undefined : { width: `${listPanelRatio * 100}%` }}
        >
          {sessionView && !selectedSession ? (
            /* ===== Session list ===== */
            <>
              {sessions.length > 0 && (
                <div className="px-3 h-[46px] border-b border-dark-700 flex items-center">
                  <span className="text-sm text-dark-400">{sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}</span>
                </div>
              )}
              <div className="flex-1 overflow-auto">
                {sessionsLoading ? (
                  <div className="flex items-center justify-center py-8 text-dark-500"><p>Loading sessions...</p></div>
                ) : sessions.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-dark-500"><p>No sessions found</p></div>
                ) : (
                  <div className="divide-y divide-dark-700">
                    {sessions.map(s => (
                      <button
                        key={s.sessionId}
                        onClick={() => openSession(s.sessionId)}
                        className="w-full text-left p-3 hover:bg-dark-800 transition-colors flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0 flex items-center gap-2">
                          <Layers className="w-4 h-4 text-primary-400 flex-shrink-0" />
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-white truncate">{s.sessionId || '(no session id)'}</div>
                            {s.lastEnqueuedTime && <div className="text-xs text-dark-500">Last: {formatDateTime(s.lastEnqueuedTime)}</div>}
                          </div>
                        </div>
                        <span className="text-xs bg-dark-600 px-2 py-1 rounded flex-shrink-0" title={sessionsReachedEnd ? undefined : 'At least this many (scan not finished)'}>
                          {s.messageCount.toLocaleString()}{!sessionsReachedEnd ? '+' : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {!sessionsLoading && (sessions.length > 0 || sessionScannedTotal > 0) && (
                  <div className="p-3 border-t border-dark-700">
                    <div className="text-xs text-dark-500 text-center mb-2">
                      Scanned {sessionScannedTotal.toLocaleString()} message{sessionScannedTotal === 1 ? '' : 's'}{sessionsReachedEnd ? ' · reached end of queue' : ''}
                    </div>
                    {!sessionsReachedEnd && (
                      <button
                        onClick={() => scanSessions(false)}
                        disabled={loadingMoreSessions}
                        className="w-full px-3 py-1.5 bg-dark-600 hover:bg-dark-500 text-dark-200 text-sm rounded-lg transition-colors disabled:opacity-50"
                      >
                        {loadingMoreSessions ? 'Scanning…' : 'Load more sessions'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            /* ===== Message list (flat, or a single session's messages) ===== */
            <>
              {inSessionMessages ? (
                <div className="px-3 h-[46px] border-b border-dark-700 flex items-center gap-2">
                  <button onClick={backToSessions} className="flex items-center gap-1 text-sm text-primary-400 hover:text-primary-300 transition-colors flex-shrink-0">
                    <ChevronLeft className="w-4 h-4" /> Sessions
                  </button>
                  <span className="text-sm text-dark-400 truncate">· {selectedSession || '(no session id)'} ({messages.length.toLocaleString()}{!sessionMsgReachedEnd ? '+' : ''})</span>
                </div>
              ) : (
                messages.length > 0 && (
                  <div className="px-3 h-[46px] border-b border-dark-700 flex items-center justify-between gap-2">
                    <span className="text-sm text-dark-400 flex-shrink-0 min-w-[100px]">
                      {selectMode && selectedMessages.size > 0
                        ? `${selectedMessages.size} selected`
                        : hasActiveFilters
                          ? `${filteredMessages.length.toLocaleString()} / ${messages.length.toLocaleString()}${loadingAll ? '+' : ''}`
                          : `${messages.length} messages`}
                    </span>
                    <div className="relative flex-1 min-w-0 max-w-xs mx-auto" ref={searchHistoryContainerRef}>
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dark-500 pointer-events-none" />
                      <input
                        data-tour="message-search"
                        type="text"
                        value={searchInput}
                        onChange={(e) => handleSearchInputChange(e.target.value)}
                        placeholder="Search messages…"
                        className="w-full pl-7 pr-14 py-1 bg-dark-800 border border-dark-700 rounded text-xs text-dark-200 placeholder-dark-500 focus:outline-none focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/30"
                      />
                      <button
                        type="button"
                        onClick={() => setSearchHistoryOpen(prev => !prev)}
                        className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-dark-500 hover:text-dark-200 rounded transition-colors"
                        title="Search history"
                      >
                        <History className="w-3.5 h-3.5" />
                      </button>
                     {(searchInput || enqueuedFromDate !== null || enqueuedToDate !== null) && (
                        <button
                         onClick={() => {
                          if (searchInput.trim()) {
                            void saveSearchTerm(searchInput);
                            searchDeletingRef.current = true;
                          }
                           setSearchInput('');
                           setSearchQuery('');
                           setEnqueuedFromDate(null);
                           setEnqueuedToDate(null);
                         }}
                        className="absolute right-6 top-1/2 -translate-y-1/2 p-0.5 text-dark-500 hover:text-dark-200 rounded transition-colors"
                         title="Clear filters"
                       >
                         <X className="w-3.5 h-3.5" />
                       </button>
                     )}
                     {searchHistoryOpen && (
                       <div className="absolute right-0 mt-1 w-72 bg-dark-800 border border-dark-600 rounded-lg shadow-lg z-20 max-h-64 overflow-y-auto">
                         {searchHistory.length === 0 ? (
                           <div className="px-3 py-2 text-xs text-dark-400">No search history yet</div>
                         ) : (
                           searchHistory.map(entry => (
                             <div
                               key={entry.term}
                               className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-dark-200 hover:bg-dark-700/60"
                             >
                               <button
                                 type="button"
                                 onClick={() => {
                                   setSearchInput(entry.term);
                                   setSearchQuery(entry.term);
                                   setSearchHistoryOpen(false);
                                 }}
                                 className="flex-1 truncate text-left"
                               >
                                 {entry.term}
                               </button>
                               <button
                                 type="button"
                                 onClick={(e) => {
                                   e.stopPropagation();
                                   toggleSearchFavorite(entry.term, !entry.isFavorite);
                                 }}
                                 className="p-0.5 text-dark-400 hover:text-yellow-400"
                                 aria-label={entry.isFavorite ? `Unfavorite ${entry.term}` : `Favorite ${entry.term}`}
                               >
                                 <Star className={`w-3.5 h-3.5 ${entry.isFavorite ? 'fill-yellow-400 text-yellow-400' : ''}`} />
                               </button>
                               <button
                                 type="button"
                                 onClick={(e) => {
                                   e.stopPropagation();
                                   deleteHistoryEntry(entry.term);
                                 }}
                                 className="p-0.5 text-dark-400 hover:text-dark-200"
                                 aria-label={`Delete ${entry.term} from history`}
                               >
                                 <X className="w-3.5 h-3.5" />
                               </button>
                             </div>
                           ))
                         )}
                       </div>
                     )}
                    </div>
                    <div className="hidden lg:flex items-center gap-1 flex-shrink-0">
                     <DatePicker
                       value={enqueuedFromDate}
                       onChange={setEnqueuedFromDate}
                       title="Enqueued from date"
                       ariaLabel="Enqueued from date"
                     />
                     <span className="text-xs text-dark-500">to</span>
                     <DatePicker
                       value={enqueuedToDate}
                       onChange={setEnqueuedToDate}
                       title="Enqueued to date"
                       ariaLabel="Enqueued to date"
                     />
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {selectMode && (
                        <button
                          onClick={toggleSelectAll}
                          className="text-xs px-2 py-1 text-primary-400 hover:text-primary-300 hover:bg-dark-600 rounded transition-colors"
                        >
                          {selectedMessages.size === filteredMessages.length ? 'Deselect All' : 'Select All'}
                        </button>
                      )}
                      <button
                        data-tour="select-mode-button"
                        onClick={toggleSelectMode}
                        className={`text-xs px-3 py-1.5 rounded transition-colors ${
                          selectMode
                            ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                            : 'bg-dark-600 text-dark-300 hover:bg-dark-500 hover:text-white'
                        }`}
                      >
                        {selectMode ? 'Cancel' : 'Select'}
                      </button>
                    </div>
                  </div>
                )
              )}
              <div ref={scrollContainerRef} onScroll={inSessionMessages ? undefined : handleScroll} className="flex-1 overflow-auto">
                {(inSessionMessages ? sessionMsgLoading : loading) ? (
                  <div className="flex items-center justify-center py-8 text-dark-500"><p>Loading...</p></div>
                ) : (
                  <>
                    {listMessages.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-8 text-dark-500 gap-1">
                        <p>
                          {inSessionMessages
                            ? 'No messages for this session in the scanned window'
                            : searchQuery.trim()
                              ? `No messages match search “${searchQuery.trim()}”`
                              : (enqueuedFromDate || enqueuedToDate)
                                ? 'No messages match the selected date range'
                                : hasActiveFilters
                                  ? 'No messages match the selected filters'
                              : 'No messages found'}
                        </p>
                        {!inSessionMessages && hasActiveFilters && loadingAll && (
                          <p className="text-xs text-dark-400 animate-pulse">Loading remaining messages…</p>
                        )}
                      </div>
                    ) : (
                      <div className="divide-y divide-dark-700">
                        {messageItems}
                        {!inSessionMessages && hasActiveFilters && loadingAll && (
                          <div className="flex items-center justify-center py-4 text-dark-400">
                            <div className="animate-pulse">Filtering all messages…</div>
                          </div>
                        )}
                        {!inSessionMessages && hasHiddenRows && (
                          <div className="flex items-center justify-center py-3 text-xs text-dark-500">
                            Showing {visibleMessages.length.toLocaleString()} of {listMessages.length.toLocaleString()}
                          </div>
                        )}
                        {!inSessionMessages && !hasActiveFilters && !hasHiddenRows && loadingMore && (
                          <div className="flex items-center justify-center py-4 text-dark-400">
                            <div className="animate-pulse">Loading more...</div>
                          </div>
                        )}
                        {!inSessionMessages && !hasActiveFilters && !hasHiddenRows && !hasMore && messages.length > 0 && (
                          <div className="flex items-center justify-center py-4 text-dark-500 text-sm">
                            No more messages
                          </div>
                        )}
                      </div>
                    )}
                    {inSessionMessages && (
                      <div className="p-3 border-t border-dark-700">
                        <div className="text-xs text-dark-500 text-center mb-2">
                          Scanned {sessionMsgScannedTotal.toLocaleString()} message{sessionMsgScannedTotal === 1 ? '' : 's'}{sessionMsgReachedEnd ? ' · reached end of queue' : ''}
                        </div>
                        {!sessionMsgReachedEnd && (
                          <button
                            onClick={() => selectedSession != null && loadSessionMessages(selectedSession, false)}
                            disabled={loadingMoreSessionMsgs}
                            className="w-full px-3 py-1.5 bg-dark-600 hover:bg-dark-500 text-dark-200 text-sm rounded-lg transition-colors disabled:opacity-50"
                          >
                            {loadingMoreSessionMsgs ? 'Scanning…' : 'Load more'}
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Resize handle - hidden on mobile */}
        {!isMobile && (
          <div
            onMouseDown={handleSplitterMouseDown}
            className={`w-1 flex-none bg-dark-700 hover:bg-primary-500 cursor-col-resize items-center justify-center group transition-colors hidden md:flex ${isResizingPanels ? 'bg-primary-500' : ''}`}
          >
            <GripVertical className="w-3 h-3 text-dark-400 group-hover:text-white opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        )}

        {/* Message Detail - full width on mobile when in detail view */}
        <div className={`
          ${isMobile
            ? mobileView === 'detail' ? 'flex-1' : 'hidden'
            : 'flex-1'
          }
          flex flex-col min-h-0 min-w-0
        `}>
          {selectedMessage ? (
            <>
              {/* Mobile back button in detail view */}
              {isMobile && (
                <div className="px-3 py-2 border-b border-dark-700 flex items-center gap-2">
                  <button
                    onClick={() => setMobileView('list')}
                    className="flex items-center gap-1 text-sm text-dark-400 hover:text-white transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    Back to list
                  </button>
                </div>
              )}
              <MessageViewer
                message={selectedMessage}
                onUseAsTemplate={(msg) => { setTemplateMessage(msg); setShowSendDialog(true); }}
                viewMode={tourForcedViewMode ?? detailsTab}
                onViewModeChange={setDetailsTab}
              />
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-dark-500 p-4">
              <p className="text-center">Select a message to view details</p>
            </div>
          )}
        </div>
      </div>

      {showSendDialog && connection && selectedEntity && (
        <SendMessageDialog connection={connection} entity={selectedEntity} templateMessage={templateMessage ?? undefined} onClose={() => { setShowSendDialog(false); setTemplateMessage(null); refreshAfterAction(); }} />
      )}

      {/* Consume Popup */}
      {showConsumePopup && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onMouseDown={e => e.target === e.currentTarget && e.button === 0 && closeConsumePopup()}>
          <div className="bg-dark-800 border border-dark-600 rounded-xl w-full max-w-sm p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-white">Consume Messages</h3>
                {inSessionMessages && (
                  <p className="text-xs text-dark-400 truncate">Session: {selectedSession || '(no session id)'}</p>
                )}
              </div>
              <button onClick={closeConsumePopup} className="text-dark-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-dark-400 mb-1">Number of messages</label>
                <input
                  type="number"
                  min="1"
                  value={consumeCount}
                  onChange={e => setConsumeCount(e.target.value)}
                  disabled={clearAll}
                  className="w-full px-3 py-2 bg-dark-900 border border-dark-500 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  placeholder="Enter count..."
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-dark-300">
                <input
                  type="checkbox"
                  checked={clearAll}
                  onChange={e => setClearAll(e.target.checked)}
                  className="rounded border-dark-500"
                />
                Clear all messages{inSessionMessages ? ' in this session' : ''}
              </label>
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={closeConsumePopup} className="px-3 py-1.5 bg-dark-600 hover:bg-dark-500 text-white text-sm rounded-lg">
                Cancel
              </button>
              <button
                onClick={handleConsumeSubmit}
                disabled={!clearAll && (!consumeCount || parseInt(consumeCount) <= 0)}
                className="px-3 py-1.5 bg-red-500 hover:bg-red-400 text-white text-sm rounded-lg disabled:opacity-50"
              >
                Consume
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Action result toast (consume / delete counts, errors like a 409 "already in progress") */}
      {actionStatus && (
        <div
          role="status"
          className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg text-sm border ${
            actionStatus.kind === 'error'
              ? 'bg-red-900/90 border-red-600 text-red-100'
              : 'bg-dark-800/95 border-dark-600 text-white'
          }`}
        >
          {actionStatus.text}
        </div>
      )}

    </div>
  );
}

// Combine session summaries from successive peek pages: sum counts per session id and
// keep the most recent enqueue time. Sorted by count (desc) so the biggest sessions lead.
function mergeSessions(existing: SessionInfo[], incoming: SessionInfo[]): SessionInfo[] {
  const map = new Map<string, SessionInfo>();
  for (const s of existing) map.set(s.sessionId, { ...s });
  for (const s of incoming) {
    const cur = map.get(s.sessionId);
    if (cur) {
      cur.messageCount += s.messageCount;
      if (s.lastEnqueuedTime && (!cur.lastEnqueuedTime || s.lastEnqueuedTime > cur.lastEnqueuedTime)) {
        cur.lastEnqueuedTime = s.lastEnqueuedTime;
      }
    } else {
      map.set(s.sessionId, { ...s });
    }
  }
  return [...map.values()].sort((a, b) => b.messageCount - a.messageCount || a.sessionId.localeCompare(b.sessionId));
}

interface MessageListItemProps {
  message: ServiceBusMessage;
  isSelected: boolean;
  isChecked: boolean;
  selectMode: boolean;
  onClick: () => void;
  showDeadLetter: boolean;
  onReturn: () => void;
}

function MessageListItem({ message, isSelected, isChecked, selectMode, onClick, showDeadLetter, onReturn }: MessageListItemProps) {
  const bodyPreview = message.body.length > 100 ? message.body.substring(0, 100) + '...' : message.body;
  const isScheduled = message.state === 'Scheduled';

  const handleReturnClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onReturn();
  };

  const scheduledBadge = isScheduled ? (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
      <Clock className="w-3 h-3" />
      {message.scheduledEnqueueTime ? formatDateTime(message.scheduledEnqueueTime) : 'Scheduled'}
    </span>
  ) : null;

  // In select mode: show large checkbox, glow when checked
  if (selectMode) {
    return (
      <div
        data-message-item
        className={`flex items-stretch cursor-pointer transition-all ${
          isChecked
            ? 'bg-primary-500/20 ring-1 ring-primary-500/50 ring-inset'
            : 'hover:bg-dark-800'
        }`}
        onClick={onClick}
      >
        {/* Large checkbox area */}
        <div className={`w-12 flex items-center justify-center border-r transition-colors ${
          isChecked ? 'bg-primary-500/30 border-primary-500/30' : 'bg-dark-850 border-dark-700'
        }`}>
          <input
            type="checkbox"
            checked={isChecked}
            onChange={() => {}}
            className="w-5 h-5 rounded border-dark-500 cursor-pointer accent-primary-500"
          />
        </div>
        {/* Message content */}
        <div className="flex-1 p-3 min-w-0">
          <div className="flex items-center justify-between mb-1 gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs text-dark-400">#{message.sequenceNumber}</span>
              {scheduledBadge}
            </div>
            {!isScheduled && <span className="text-xs text-dark-500 flex-shrink-0">{formatDateTime(message.enqueuedTime)}</span>}
          </div>
          {message.subject && <div className="text-sm font-medium text-white mb-1">{message.subject}</div>}
          <div className="text-sm text-dark-300 truncate">{bodyPreview}</div>
          {message.deadLetterReason && <div className="text-xs text-red-400 mt-1">Reason: {message.deadLetterReason}</div>}
        </div>
      </div>
    );
  }

  // Normal mode: no checkbox
  return (
    <div data-message-item className={`p-3 cursor-pointer transition-colors ${isSelected ? 'bg-primary-500/20' : 'hover:bg-dark-800'}`} onClick={onClick}>
      <div className="flex items-center justify-between mb-1 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-dark-400">#{message.sequenceNumber}</span>
          {scheduledBadge}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {!isScheduled && <span className="text-xs text-dark-500">{formatDateTime(message.enqueuedTime)}</span>}
          {showDeadLetter && (
            <button
              type="button"
              onClick={handleReturnClick}
              className="p-1.5 text-dark-400 hover:text-green-400 hover:bg-dark-600 rounded transition-colors"
              title="Return to queue"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      {message.subject && <div className="text-sm font-medium text-white mb-1">{message.subject}</div>}
      <div className="text-sm text-dark-300 truncate">{bodyPreview}</div>
      {message.deadLetterReason && <div className="text-xs text-red-400 mt-1">Reason: {message.deadLetterReason}</div>}
    </div>
  );
}
