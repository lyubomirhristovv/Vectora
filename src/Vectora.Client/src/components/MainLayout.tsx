import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { LogOut, RefreshCw, ChevronDown, Check, Menu, X, Settings, GripVertical } from 'lucide-react';
import type { Connection, QueueInfo, TopicInfo, SelectedEntity } from '../types';
import { getConnections, getEntities, getQueueRuntimeInfo, getSubscriptionRuntimeInfo, getSettings, updateSettings } from '../api/client';
import { mergeMessageCount, type MessageCount } from '../utils/messageCounts';
import ConnectionManager from './ConnectionManager';
import EntityBrowser from './EntityBrowser';
import MessagePanel from './MessagePanel';
import SettingsDialog from './SettingsDialog';
import TourGuide, {
  TOUR_STEPS,
  TOUR_DUMMY_CONNECTION,
  TOUR_DUMMY_CONNECTIONS,
  TOUR_DUMMY_QUEUES,
  TOUR_DUMMY_TOPICS,
  TOUR_DUMMY_SELECTED_ENTITY,
  TOUR_DUMMY_MESSAGES,
  TOUR_ENTITY_BROWSER_FIRST_STEP,
  TOUR_MESSAGE_PANEL_FIRST_STEP,
  TOUR_LAST_DATA_STEP,
  TOUR_MANAGE_CONNECTIONS_STEP,
  TOUR_ENTITY_SWIPE_STEP,
  TOUR_MESSAGE_VIEW_TABS_STEP,
} from './TourGuide';

const LAST_CONNECTION_KEY = 'vectora_last_connection';

// Draggable entity browser width (desktop only). Long queue/topic names need more room, but the
// message panel's toolbar doesn't shrink gracefully, so the panel can only grow to twice its
// default and never past half the window.
const SIDEBAR_WIDTH_KEY = 'vectora_sidebar_width';
const SIDEBAR_MIN_WIDTH = 320;
const SIDEBAR_MAX_WIDTH = 640;

const clampSidebarWidth = (width: number, containerWidth?: number) => {
  const max = containerWidth ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, containerWidth / 2)) : SIDEBAR_MAX_WIDTH;
  return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, width));
};

const REFRESH_THROTTLE_MS = 5 * 60 * 1000;

// Entity names repeat across namespaces, so loaded-message counts are keyed per connection.
const loadedCountKey = (connectionId: number, entity: SelectedEntity) =>
  entity.type === 'subscription' && entity.topicName
    ? `${connectionId}:sub:${entity.topicName}/${entity.name}`
    : `${connectionId}:queue:${entity.name}`;

// Emulator message counts are filled in by a background sweep on the server (browsing is far too
// slow to hold a request open), so the first response can carry provisional numbers. Poll the cheap
// cached endpoint until the server reports the sweep finished.
const COUNTS_POLL_INTERVAL_MS = 2000;
const COUNTS_POLL_TIMEOUT_MS = 120000;

// Hook to detect mobile viewport
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return isMobile;
}

interface MainLayoutProps {
  onLogout: () => void;
  showLogout?: boolean;
}

export default function MainLayout({ onLogout, showLogout = true }: MainLayoutProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedConnection, setSelectedConnection] = useState<Connection | null>(null);
  const [queues, setQueues] = useState<QueueInfo[]>([]);
  const [topics, setTopics] = useState<TopicInfo[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity | null>(null);
  const [loading, setLoading] = useState(false);
  const [showConnectionManager, setShowConnectionManager] = useState(false);
  const [showConnectionDropdown, setShowConnectionDropdown] = useState(false);
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [tourInitialStep, setTourInitialStep] = useState(0);
  const [tourCurrentStep, setTourCurrentStep] = useState(-1);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Tracks whether the tour (not the user) opened the connection dropdown,
  // so we can close it when the tour step changes away.
  const tourControlledDropdownRef = useRef(false);
  const isMobile = useIsMobile();

  // Draggable splitter between the entity browser and the message panel (desktop only).
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = parseFloat(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? '');
    return Number.isFinite(saved) ? clampSidebarWidth(saved) : SIDEBAR_MIN_WIDTH;
  });
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const mainContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingSidebar(true);
  }, []);

  useEffect(() => {
    if (!isResizingSidebar) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = mainContentRef.current?.getBoundingClientRect();
      if (!rect) return;
      setSidebarWidth(clampSidebarWidth(e.clientX - rect.left, rect.width));
    };
    const handleMouseUp = () => setIsResizingSidebar(false);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingSidebar]);

  // Keep the panel within bounds when the window (and so the container) shrinks.
  useEffect(() => {
    if (isMobile) return;
    const handleResize = () => {
      const rect = mainContentRef.current?.getBoundingClientRect();
      if (!rect) return;
      setSidebarWidth(width => clampSidebarWidth(width, rect.width));
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isMobile]);

  // Close mobile sidebar when entity is selected
  const handleSelectEntity = (entity: SelectedEntity | null) => {
    setSelectedEntity(entity);
    if (isMobile && entity) {
      setShowMobileSidebar(false);
    }
    if (entity && selectedConnection) {
      updateEntityCount(entity);
    }
  };

  const loadConnections = async () => {
    try {
      const data = await getConnections();
      setConnections(data);

      // Restore last connection
      const lastConnectionId = localStorage.getItem(LAST_CONNECTION_KEY);
      if (lastConnectionId && !selectedConnection) {
        const conn = data.find(c => c.id === Number(lastConnectionId));
        if (conn) setSelectedConnection(conn);
      }
    } catch (error) {
      console.error('Failed to load connections:', error);
    }
  };

  const lastRefreshRef = useRef<Map<number, number>>(new Map());
  const inFlightRefreshRef = useRef<Set<number>>(new Set());

  const selectedConnectionRef = useRef(selectedConnection);
  selectedConnectionRef.current = selectedConnection;

  const applyEntities = useCallback((data: { queues: QueueInfo[]; topics: TopicInfo[] }) => {
    setQueues(data.queues);
    setTopics(data.topics);
  }, []);

  // What the message panel has proved about an entity's counts by actually loading its messages.
  // Keyed "<connectionId>:queue:<name>" / "<connectionId>:sub:<topic>/<name>", holding the active
  // and dead-letter sub-queues separately because the panel only loads one of them at a time. The
  // connection id is part of the key because entity names repeat across namespaces — an emulator
  // usually mirrors the real one — and these counts are only ever valid for the emulator.
  const [loadedCounts, setLoadedCounts] = useState<Record<string, { active?: MessageCount; deadLetter?: MessageCount }>>({});

  const handleMessagesLoaded = useCallback((entity: SelectedEntity, loaded: number, reachedEnd: boolean, deadLetter: boolean) => {
    // Real Service Bus reports exact counts from the admin API; only emulator counts need this.
    const connection = selectedConnectionRef.current;
    if (!connection?.isEmulator) return;
    const key = loadedCountKey(connection.id, entity);
    setLoadedCounts(prev => ({
      ...prev,
      [key]: { ...prev[key], [deadLetter ? 'deadLetter' : 'active']: { count: loaded, isExact: reachedEnd } },
    }));
  }, []);

  // One poll loop at a time per connection; cancelled when the connection changes or we unmount.
  const countsPollRef = useRef<{ connectionId: number; cancelled: boolean } | null>(null);

  const stopCountsPoll = useCallback(() => {
    if (countsPollRef.current) countsPollRef.current.cancelled = true;
    countsPollRef.current = null;
  }, []);

  const pollCountsUntilSettled = useCallback((connectionId: number) => {
    stopCountsPoll();
    const token = { connectionId, cancelled: false };
    countsPollRef.current = token;

    const startedAt = Date.now();
    const tick = async () => {
      if (token.cancelled) return;
      if (Date.now() - startedAt >= COUNTS_POLL_TIMEOUT_MS) {
        if (countsPollRef.current === token) countsPollRef.current = null;
        return;
      }
      try {
        // Deliberately unrefreshed: refreshCache=true would re-enumerate and restart the sweep,
        // so the pending flag would never clear.
        const data = await getEntities(connectionId, false);
        if (token.cancelled || selectedConnectionRef.current?.id !== connectionId) return;
        applyEntities(data);
        if (!data.countsPending) {
          if (countsPollRef.current === token) countsPollRef.current = null;
          return;
        }
      } catch (error) {
        console.error('Failed to poll entity counts:', error);
      }
      if (!token.cancelled) setTimeout(tick, COUNTS_POLL_INTERVAL_MS);
    };

    setTimeout(tick, COUNTS_POLL_INTERVAL_MS);
  }, [applyEntities, stopCountsPoll]);

  useEffect(() => stopCountsPoll, [stopCountsPoll]);

  const refreshConnection = useCallback(async (connectionId: number) => {
    if (inFlightRefreshRef.current.has(connectionId)) return;
    inFlightRefreshRef.current.add(connectionId);
    if (selectedConnectionRef.current?.id === connectionId) setLoading(true);
    try {
      const data = await getEntities(connectionId, true);
      lastRefreshRef.current.set(connectionId, Date.now());
      // A refresh re-browses every entity, so previously loaded totals are no longer a better
      // source than the server's — and a stale exact count must not pin the counter forever.
      setLoadedCounts({});
      if (selectedConnectionRef.current?.id === connectionId) {
        applyEntities(data);
        if (data.countsPending) pollCountsUntilSettled(connectionId);
      }
    } catch (error) {
      console.error('Failed to refresh entities:', error);
    } finally {
      inFlightRefreshRef.current.delete(connectionId);
      if (selectedConnectionRef.current?.id === connectionId) setLoading(false);
    }
  }, [applyEntities, pollCountsUntilSettled]);

  const openConnection = useCallback(async (connectionId: number) => {
    if (selectedConnectionRef.current?.id === connectionId) setLoading(true);
    try {
      const data = await getEntities(connectionId, false);
      if (selectedConnectionRef.current?.id === connectionId) {
        applyEntities(data);
        if (data.countsPending) pollCountsUntilSettled(connectionId);
      }
    } catch (error) {
      console.error('Failed to load cached entities:', error);
    }
    const lastRefresh = lastRefreshRef.current.get(connectionId) ?? 0;
    const stale = Date.now() - lastRefresh >= REFRESH_THROTTLE_MS;
    if (stale && !inFlightRefreshRef.current.has(connectionId)) {
      refreshConnection(connectionId);
    } else if (selectedConnectionRef.current?.id === connectionId) {
      setLoading(false);
    }
  }, [applyEntities, refreshConnection, pollCountsUntilSettled]);

  const refreshEntities = useCallback(() => {
    if (selectedConnectionRef.current) refreshConnection(selectedConnectionRef.current.id);
  }, [refreshConnection]);

  const handleSelectConnection = (conn: Connection | null) => {
    setSelectedConnection(conn);
    setShowConnectionDropdown(false);
    if (conn) {
      localStorage.setItem(LAST_CONNECTION_KEY, String(conn.id));
    } else {
      localStorage.removeItem(LAST_CONNECTION_KEY);
    }
  };

  const updateEntityCount = useCallback(async (entity: SelectedEntity, recount = false) => {
    const connectionId = selectedConnectionRef.current?.id;
    if (connectionId == null) return;
    try {
      if (entity.type === 'queue') {
        const info = await getQueueRuntimeInfo(connectionId, entity.name, recount);
        if (selectedConnectionRef.current?.id !== connectionId) return;
        setQueues(prev => prev.map(q => q.name === entity.name ? { ...q, activeMessageCount: info.activeMessageCount, deadLetterMessageCount: info.deadLetterMessageCount, activeCountExact: info.activeCountExact, deadLetterCountExact: info.deadLetterCountExact } : q));
      } else if (entity.type === 'subscription' && entity.topicName) {
        const info = await getSubscriptionRuntimeInfo(connectionId, entity.topicName, entity.name, recount);
        if (selectedConnectionRef.current?.id !== connectionId) return;
        setTopics(prev => prev.map(t => t.name === entity.topicName ? {
          ...t,
          subscriptions: t.subscriptions.map(s => s.name === entity.name ? { ...s, activeMessageCount: info.activeMessageCount, deadLetterMessageCount: info.deadLetterMessageCount, activeCountExact: info.activeCountExact, deadLetterCountExact: info.deadLetterCountExact } : s)
        } : t));
      }
    } catch (error) {
      console.error('Failed to update entity count:', error);
    }
  }, []);

  useEffect(() => {
    loadConnections();
  }, []);

  // Load settings once to determine whether the tour should auto-start.
  useEffect(() => {
    getSettings().then(settings => {
      const completed = settings.tourGuideCompletedStep;
      if (completed < TOUR_STEPS.length) {
        setTourInitialStep(completed);
        setShowTour(true);
      }
    }).catch(() => { /* ignore – tour remains hidden */ });
  }, []);

  const handleTourComplete = useCallback(async () => {
    setShowTour(false);
    setTourCurrentStep(-1);
    try {
      await updateSettings({ tourGuideCompletedStep: TOUR_STEPS.length });
    } catch {
      // Non-critical; ignore
    }
  }, []);

  const handleTourSkip = useCallback(async () => {
    setShowTour(false);
    setTourCurrentStep(-1);
    try {
      await updateSettings({ tourGuideCompletedStep: TOUR_STEPS.length });
    } catch {
      // Non-critical; ignore
    }
  }, []);

  // Open the connection dropdown automatically on the manage-connections step so the
  // spotlight can highlight the "Manage Connections…" button inside it.
  useEffect(() => {
    if (showTour && tourCurrentStep === TOUR_MANAGE_CONNECTIONS_STEP) {
      setShowConnectionDropdown(true);
      tourControlledDropdownRef.current = true;
    } else if (tourControlledDropdownRef.current) {
      setShowConnectionDropdown(false);
      tourControlledDropdownRef.current = false;
    }
  }, [showTour, tourCurrentStep]);

  useEffect(() => {
    setSelectedEntity(null);
    const conn = selectedConnection;
    if (!conn) {
      setQueues([]);
      setTopics([]);
      setLoading(false);
      return;
    }
    setQueues([]);
    setTopics([]);
    openConnection(conn.id);
  }, [selectedConnection, openConnection]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (isMobile) return;

    const handleClickOutside = (e: MouseEvent) => {
      // While the tour is driving the dropdown open (manage-connections step),
      // ignore outside clicks so the spotlight target stays mounted. Clicking the
      // tour overlay otherwise closes the dropdown, leaving the step with no
      // target and re-showing it centered.
      if (tourControlledDropdownRef.current) return;
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowConnectionDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isMobile]);

  const handleLogout = () => {
    localStorage.removeItem('vectora_token');
    onLogout();
  };

  // ── Tour dummy-data injection ─────────────────────────────────────────────
  // When the tour is active we override the real connection/entity/queue state
  // with static fixtures so the UI shows fully-populated panels instead of
  // empty-state placeholders. This is purely presentational — no real API calls
  // are made with the dummy connection (id = -1).
  const tourNeedsEntityBrowser =
    showTour &&
    tourCurrentStep >= TOUR_ENTITY_BROWSER_FIRST_STEP &&
    tourCurrentStep <= TOUR_LAST_DATA_STEP;

  const tourNeedsMessagePanel =
    showTour &&
    tourCurrentStep >= TOUR_MESSAGE_PANEL_FIRST_STEP &&
    tourCurrentStep <= TOUR_LAST_DATA_STEP;

  // Step-specific tour overrides
  const tourIsManageConnections = showTour && tourCurrentStep === TOUR_MANAGE_CONNECTIONS_STEP;
  const tourIsEntitySwipe = showTour && tourCurrentStep === TOUR_ENTITY_SWIPE_STEP;
  const tourIsMessageViewTabs = showTour && tourCurrentStep === TOUR_MESSAGE_VIEW_TABS_STEP;

  const effectiveConnection: Connection | null = tourNeedsEntityBrowser
    ? TOUR_DUMMY_CONNECTION
    : selectedConnection;

  // Only emulator counts are ever browse-derived; a real namespace's admin counts are exact and
  // must never be overridden by what some other connection's message list happened to show.
  const countsConnectionId = selectedConnection?.isEmulator ? selectedConnection.id : null;

  const countedQueues: QueueInfo[] = useMemo(() => countsConnectionId == null ? queues : queues.map(queue => {
    const loaded = loadedCounts[`${countsConnectionId}:queue:${queue.name}`];
    if (!loaded) return queue;
    const active = mergeMessageCount({ count: queue.activeMessageCount, isExact: queue.activeCountExact ?? true }, loaded.active);
    const dlq = mergeMessageCount({ count: queue.deadLetterMessageCount, isExact: queue.deadLetterCountExact ?? true }, loaded.deadLetter);
    return {
      ...queue,
      activeMessageCount: active.count,
      activeCountExact: active.isExact,
      deadLetterMessageCount: dlq.count,
      deadLetterCountExact: dlq.isExact,
    };
  }), [queues, loadedCounts, countsConnectionId]);

  const countedTopics: TopicInfo[] = useMemo(() => countsConnectionId == null ? topics : topics.map(topic => ({
    ...topic,
    subscriptions: topic.subscriptions.map(sub => {
      const loaded = loadedCounts[`${countsConnectionId}:sub:${topic.name}/${sub.name}`];
      if (!loaded) return sub;
      const active = mergeMessageCount({ count: sub.activeMessageCount, isExact: sub.activeCountExact ?? true }, loaded.active);
      const dlq = mergeMessageCount({ count: sub.deadLetterMessageCount, isExact: sub.deadLetterCountExact ?? true }, loaded.deadLetter);
      return {
        ...sub,
        activeMessageCount: active.count,
        activeCountExact: active.isExact,
        deadLetterMessageCount: dlq.count,
        deadLetterCountExact: dlq.isExact,
      };
    }),
  })), [topics, loadedCounts, countsConnectionId]);

  const effectiveQueues: QueueInfo[] = tourNeedsEntityBrowser ? TOUR_DUMMY_QUEUES : countedQueues;
  const effectiveTopics = tourNeedsEntityBrowser ? TOUR_DUMMY_TOPICS : countedTopics;

  const effectiveSelectedEntity: SelectedEntity | null = tourNeedsMessagePanel
    ? TOUR_DUMMY_SELECTED_ENTITY
    : selectedEntity;

  const tourDummyMessagesForPanel = tourNeedsMessagePanel ? TOUR_DUMMY_MESSAGES : undefined;

  // Dropdown connections & selected item shown during the manage-connections step.
  const dropdownConnections = tourIsManageConnections ? TOUR_DUMMY_CONNECTIONS : connections;
  const dropdownSelectedId = tourIsManageConnections ? TOUR_DUMMY_CONNECTION.id : selectedConnection?.id;

  return (
    <div className="h-full bg-dark-950 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="bg-dark-900 border-b border-dark-700 px-3 md:px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3 md:gap-6">
          {/* Mobile menu button */}
          {isMobile && (
            <button
              onClick={() => setShowMobileSidebar(!showMobileSidebar)}
              className="p-2 -ml-1 text-dark-400 hover:text-white transition-colors"
            >
              {showMobileSidebar ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          )}

          {/* Logo */}
          <div className="flex items-center gap-2 md:gap-3">
            <div className="w-7 h-7 md:w-8 md:h-8 bg-dark-800 border border-dark-600 rounded-lg flex items-center justify-center">
              <img src="/vectora-logo.svg" alt="Vectora" className="w-5 h-5 md:w-6 md:h-6 drop-shadow-[0_0_6px_rgba(14,165,233,0.5)]" />
            </div>
            <h1 className="text-lg md:text-xl font-bold bg-gradient-to-r from-primary-400 to-purple-400 bg-clip-text text-transparent">
              Vectora
            </h1>
          </div>

          {/* Connection Selector - hidden on mobile (moved to sidebar) */}
          <div className="relative hidden md:block" ref={dropdownRef}>
            <button
              data-tour="connection-selector"
              onClick={() => setShowConnectionDropdown(!showConnectionDropdown)}
              className="flex items-center gap-2 px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg hover:border-dark-500 transition-colors min-w-[240px]"
            >
              <div className="flex-1 text-left">
                {selectedConnection ? (
                  <div>
                    <div className="text-sm font-medium text-white">{selectedConnection.name}</div>
                    <div className="text-xs text-dark-400">{selectedConnection.isEmulator ? 'Emulator' : 'Azure Service Bus'}</div>
                  </div>
                ) : (
                  <span className="text-sm text-dark-400">Select connection...</span>
                )}
              </div>
              <ChevronDown className={`w-4 h-4 text-dark-400 transition-transform ${showConnectionDropdown ? 'rotate-180' : ''}`} />
            </button>

            {showConnectionDropdown && (
              <div className="absolute top-full left-0 mt-2 w-72 bg-dark-800 border border-dark-600 rounded-xl shadow-xl z-50 overflow-hidden">
                <div className="max-h-80 overflow-auto">
                  {dropdownConnections.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-dark-400">No connections configured</div>
                  ) : (
                    dropdownConnections.map(conn => (
                      <button
                        key={conn.id}
                        onClick={() => { if (!tourIsManageConnections) handleSelectConnection(conn); }}
                        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                          dropdownSelectedId === conn.id
                            ? 'bg-primary-500/20 border-l-2 border-primary-500'
                            : 'hover:bg-dark-700 border-l-2 border-transparent'
                        }`}
                      >
                        <div className="flex-1">
                          <div className={`font-medium ${dropdownSelectedId === conn.id ? 'text-primary-400' : 'text-white'}`}>
                            {conn.name}
                          </div>
                          <div className="text-xs text-dark-400 mt-0.5">
                            {conn.isEmulator ? 'Emulator' : 'Azure Service Bus'}
                          </div>
                        </div>
                        {dropdownSelectedId === conn.id && (
                          <Check className="w-4 h-4 text-primary-400" />
                        )}
                      </button>
                    ))
                  )}
                </div>
                <div className="border-t border-dark-600 p-2">
                  <button
                    data-tour="manage-connections"
                    onClick={() => { setShowConnectionDropdown(false); setShowConnectionManager(true); }}
                    className="w-full px-3 py-2 text-sm text-primary-400 hover:bg-dark-700 rounded-lg transition-colors"
                  >
                    Manage Connections...
                  </button>
                </div>
              </div>
            )}
          </div>

          {selectedConnection && !isMobile && (
            <button
              onClick={refreshEntities}
              disabled={loading}
              className="p-2 text-dark-400 hover:text-white transition-colors"
              title="Refresh entities"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>

        {/* Right side actions */}
        <div className="flex items-center gap-2 md:gap-4">
          <button
            data-tour="settings-button"
            onClick={() => setShowSettings(true)}
            className="flex items-center gap-2 text-dark-400 hover:text-white transition-colors text-sm p-2 md:p-0"
            title="Settings"
          >
            <Settings className="w-4 h-4" />
            <span className="hidden md:inline">Settings</span>
          </button>
          {showLogout && (
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 text-dark-400 hover:text-white transition-colors text-sm p-2 md:p-0"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden md:inline">Logout</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <div ref={mainContentRef} className={`flex-1 flex overflow-hidden min-h-0 relative ${isResizingSidebar ? 'select-none' : ''}`}>
        {/* Mobile Sidebar Overlay */}
        {isMobile && showMobileSidebar && (
          <div
            className="absolute inset-0 bg-black/50 z-40"
            onClick={() => setShowMobileSidebar(false)}
          />
        )}

        {/* Entity Browser - Left Panel / Mobile Drawer */}
        <div
          data-tour="entity-browser"
          style={isMobile ? undefined : { width: sidebarWidth }}
          className={`
          ${isMobile
            ? `absolute inset-y-0 left-0 z-50 w-[85%] max-w-sm transform transition-transform duration-300 ease-in-out ${showMobileSidebar ? 'translate-x-0' : '-translate-x-full'}`
            : 'flex-none relative'
          }
          border-r border-dark-700 overflow-hidden flex flex-col bg-dark-950
        `}>
          {/* Mobile connection selector */}
          {isMobile && (
            <div className="p-3 border-b border-dark-700 bg-dark-900">
              <button
                onClick={() => setShowConnectionDropdown(!showConnectionDropdown)}
                className="flex items-center gap-2 px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg hover:border-dark-500 transition-colors w-full"
              >
                <div className="flex-1 text-left min-w-0">
                  {selectedConnection ? (
                    <div>
                      <div className="text-sm font-medium text-white truncate">{selectedConnection.name}</div>
                      <div className="text-xs text-dark-400">{selectedConnection.isEmulator ? 'Emulator' : 'Azure Service Bus'}</div>
                    </div>
                  ) : (
                    <span className="text-sm text-dark-400">Select connection...</span>
                  )}
                </div>
                <ChevronDown className={`w-4 h-4 text-dark-400 flex-shrink-0 transition-transform ${showConnectionDropdown ? 'rotate-180' : ''}`} />
              </button>
              {showConnectionDropdown && (
                <div className="mt-2 bg-dark-800 border border-dark-600 rounded-xl shadow-xl overflow-hidden">
                  <div className="max-h-60 overflow-auto">
                    {connections.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-dark-400">No connections configured</div>
                    ) : (
                      connections.map(conn => (
                        <button
                          key={conn.id}
                          onClick={() => { handleSelectConnection(conn); setShowConnectionDropdown(false); }}
                          className="w-full px-4 py-3 text-left hover:bg-dark-700 transition-colors flex items-center justify-between"
                        >
                          <div>
                            <div className="text-sm font-medium text-white">{conn.name}</div>
                            <div className="text-xs text-dark-400">{conn.isEmulator ? 'Emulator' : 'Azure Service Bus'}</div>
                          </div>
                          {selectedConnection?.id === conn.id && (
                            <Check className="w-4 h-4 text-primary-400" />
                          )}
                        </button>
                      ))
                    )}
                  </div>
                  <div className="border-t border-dark-600 p-2">
                    <button
                      onClick={() => { setShowConnectionDropdown(false); setShowMobileSidebar(false); setShowConnectionManager(true); }}
                      className="w-full px-3 py-2 text-sm text-primary-400 hover:bg-dark-700 rounded-lg transition-colors"
                    >
                      Manage Connections...
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          <EntityBrowser
            connection={effectiveConnection}
            queues={effectiveQueues}
            topics={effectiveTopics}
            selectedEntity={effectiveSelectedEntity}
            onSelectEntity={handleSelectEntity}
            onRefresh={tourNeedsEntityBrowser ? () => {} : refreshEntities}
            loading={tourNeedsEntityBrowser ? false : loading}
            tourSwipeActive={tourIsEntitySwipe}
          />
        </div>

        {/* Resize handle between the two panels - hidden on mobile */}
        {!isMobile && (
          <div
            onMouseDown={handleSidebarResizeStart}
            onDoubleClick={() => setSidebarWidth(SIDEBAR_MIN_WIDTH)}
            title="Drag to resize. Double-click to reset."
            className={`w-1 flex-none bg-dark-700 hover:bg-primary-500 cursor-col-resize flex items-center justify-center group transition-colors ${isResizingSidebar ? 'bg-primary-500' : ''}`}
          >
            <GripVertical className="w-3 h-3 text-dark-400 group-hover:text-white opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        )}

        {/* Message Panel - Right Panel / Full width on mobile */}
        <div data-tour="message-panel" className="flex-1 min-w-0 overflow-hidden h-full">
          <MessagePanel
            connection={effectiveConnection}
            selectedEntity={effectiveSelectedEntity}
            queues={effectiveQueues}
            topics={effectiveTopics}
            onUpdateEntityCount={tourNeedsMessagePanel ? undefined : updateEntityCount}
            onMessagesLoaded={tourNeedsMessagePanel ? undefined : handleMessagesLoaded}
            isMobile={isMobile}
            onOpenSidebar={() => setShowMobileSidebar(true)}
            tourDummyMessages={tourDummyMessagesForPanel}
            tourForcedViewMode={tourIsMessageViewTabs ? 'properties' : undefined}
          />
        </div>
      </div>

      {/* Connection Manager Modal */}
      {showConnectionManager && (
        <ConnectionManager
          onClose={() => {
            setShowConnectionManager(false);
            loadConnections();
          }}
        />
      )}

      {showSettings && (
        <SettingsDialog
          onClose={() => setShowSettings(false)}
          onStartTour={() => { setShowSettings(false); setTourInitialStep(0); setShowTour(true); }}
        />
      )}

      {showTour && (
        <TourGuide
          steps={TOUR_STEPS}
          initialStep={tourInitialStep}
          onComplete={handleTourComplete}
          onSkip={handleTourSkip}
          onStepChange={setTourCurrentStep}
        />
      )}
    </div>
  );
}
