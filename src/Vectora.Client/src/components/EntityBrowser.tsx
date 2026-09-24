import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ChevronRight, ChevronDown, Inbox, MessageSquare, Users, Search, Plus, X, Trash2, Pencil, Loader2, Star, History } from 'lucide-react';
import type { Connection, QueueInfo, TopicInfo, SubscriptionInfo, SelectedEntity, SearchHistoryEntry } from '../types';
import { createQueue, createTopic, createSubscription, deleteQueue, deleteTopic, deleteSubscription, getSearchHistory, recordSearchHistory, setSearchHistoryFavorite, deleteSearchHistory } from '../api/client';
import EditEntityDialog from './EditEntityDialog';
import CreateEntityDialog from './CreateEntityDialog';
import type { CreateEntityPayload } from './CreateEntityDialog';
import { formatMessageCount } from '../utils/messageCounts';

const subscriptionKey = (topicName: string, subName: string) => `${topicName}/${subName}`;
const ENTITY_SEARCH_KEY = '5f0d2c2f-3d64-4f40-9e78-4f1a64d18ef3';

interface EntityBrowserProps {
  connection: Connection | null;
  queues: QueueInfo[];
  topics: TopicInfo[];
  selectedEntity: SelectedEntity | null;
  onSelectEntity: (entity: SelectedEntity | null) => void;
  onRefresh: () => void;
  loading: boolean;
  // When true, the first entity item plays the swipe-demo animation (tour use).
  tourSwipeActive?: boolean;
}

type CreateMode = null | 'queue' | 'topic' | 'subscription';
type EntityType = 'queue' | 'topic' | 'subscription';

interface DeleteTarget {
  type: EntityType;
  name: string;
  topicName?: string;
}

interface EditTarget {
  type: EntityType;
  name: string;
  topicName?: string;
}

export default function EntityBrowser({ connection, queues, topics, selectedEntity, onSelectEntity, onRefresh, loading, tourSwipeActive }: EntityBrowserProps) {
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryEntry[]>([]);
  const [searchHistoryOpen, setSearchHistoryOpen] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>(null);
  const [createTopicName, setCreateTopicName] = useState('');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Edit state
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

  // Per-entity loading state: an entity is "pending" when its create/update/delete
  // is in flight or the refresh that reflects it has not yet completed. Routine
  // refreshes don't populate these sets, so the rest of the list stays interactive.
  const [pendingQueues, setPendingQueues] = useState<Set<string>>(new Set());
  const [pendingTopics, setPendingTopics] = useState<Set<string>>(new Set());
  const [pendingSubscriptions, setPendingSubscriptions] = useState<Set<string>>(new Set());
  const [optimisticQueues, setOptimisticQueues] = useState<QueueInfo[]>([]);
  const [optimisticTopics, setOptimisticTopics] = useState<TopicInfo[]>([]);
  const [optimisticSubscriptions, setOptimisticSubscriptions] = useState<Array<{ topicName: string; sub: SubscriptionInfo }>>([]);
  const searchHistoryContainerRef = useRef<HTMLDivElement>(null);
  const searchDeletingRef = useRef(false);

  const sortHistoryEntries = (entries: SearchHistoryEntry[]) => {
    return [...entries].sort((a, b) => {
      if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;

      // Match backend ordering semantics (favorites: alpha, case-insensitive)
      if (a.isFavorite) return a.term.localeCompare(b.term, undefined, { sensitivity: 'base' });

      // Non-favorites: newest-first, with term tiebreaker (case-insensitive)
      const dateDiff = new Date(b.lastSearchedAt).getTime() - new Date(a.lastSearchedAt).getTime();
      if (dateDiff !== 0) return dateDiff;
      return a.term.localeCompare(b.term, undefined, { sensitivity: 'base' });
    });
  };

  const loadSearchHistory = useCallback(async () => {
    try {
      const entries = await getSearchHistory(ENTITY_SEARCH_KEY);
      setSearchHistory(sortHistoryEntries(entries));
    } catch (err) {
      console.error('Failed to load entity search history:', err);
    }
  }, []);

  const saveSearchTerm = useCallback(async (term: string) => {
    const trimmed = term.trim();
    if (!trimmed) return;
    try {
      await recordSearchHistory(ENTITY_SEARCH_KEY, trimmed);
      await loadSearchHistory();
    } catch (err) {
      console.error('Failed to save entity search history:', err);
    }
  }, [loadSearchHistory]);

  const setFavorite = useCallback(async (term: string, isFavorite: boolean) => {
    try {
      await setSearchHistoryFavorite(ENTITY_SEARCH_KEY, term, isFavorite);
      setSearchHistory(prev => sortHistoryEntries(prev.map(entry =>
        entry.term === term
          ? { ...entry, isFavorite, lastSearchedAt: new Date().toISOString() }
          : entry)));
    } catch (err) {
      console.error('Failed to update entity search favorite:', err);
    }
  }, []);

  const deleteHistoryEntry = useCallback(async (term: string) => {
    try {
      await deleteSearchHistory(ENTITY_SEARCH_KEY, term);
      setSearchHistory(prev => prev.filter(entry => entry.term !== term));
    } catch (err) {
      console.error('Failed to delete entity search history entry:', err);
    }
  }, []);

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
    if (searchHistoryOpen && (createMode !== null || deleteTarget !== null || editTarget !== null)) {
      setSearchHistoryOpen(false);
    }
  }, [searchHistoryOpen, createMode, deleteTarget, editTarget]);

  useEffect(() => {
    const trimmed = searchTerm.trim();
    if (!trimmed) return;
    const timer = setTimeout(() => {
      saveSearchTerm(trimmed);
    }, 10000);
    return () => clearTimeout(timer);
  }, [searchTerm, saveSearchTerm]);

  const handleSearchChange = (value: string) => {
    setSearchHistoryOpen(false);
    if (value.length < searchTerm.length) {
      if (!searchDeletingRef.current) {
        saveSearchTerm(searchTerm);
      }
      searchDeletingRef.current = true;
    } else {
      searchDeletingRef.current = false;
    }
    setSearchTerm(value);
  };

  // Clear pending + optimistic state once a refresh completes — the server's
  // response is now authoritative for the entities we were waiting on.
  const prevLoadingRef = useRef(loading);
  useEffect(() => {
    if (prevLoadingRef.current && !loading) {
      setPendingQueues(new Set());
      setPendingTopics(new Set());
      setPendingSubscriptions(new Set());
      setOptimisticQueues([]);
      setOptimisticTopics([]);
      setOptimisticSubscriptions([]);
    }
    prevLoadingRef.current = loading;
  }, [loading]);

  const mergedQueues = useMemo(() => {
    if (optimisticQueues.length === 0) return queues;
    const names = new Set(queues.map(q => q.name));
    return [...queues, ...optimisticQueues.filter(q => !names.has(q.name))];
  }, [queues, optimisticQueues]);

  const mergedTopics = useMemo<TopicInfo[]>(() => {
    if (optimisticTopics.length === 0 && optimisticSubscriptions.length === 0) return topics;
    const existingNames = new Set(topics.map(t => t.name));
    const base: TopicInfo[] = [
      ...topics,
      ...optimisticTopics.filter(t => !existingNames.has(t.name)),
    ];
    if (optimisticSubscriptions.length === 0) return base;
    return base.map(t => {
      const extras = optimisticSubscriptions.filter(s => s.topicName === t.name);
      if (extras.length === 0) return t;
      const subNames = new Set(t.subscriptions.map(s => s.name));
      return {
        ...t,
        subscriptions: [
          ...t.subscriptions,
          ...extras.filter(e => !subNames.has(e.sub.name)).map(e => e.sub),
        ],
      };
    });
  }, [topics, optimisticTopics, optimisticSubscriptions]);

  const openEditDialog = (type: EntityType, name: string, topicName?: string) => {
    setEditTarget({ type, name, topicName });
  };

  const closeEditDialog = () => {
    setEditTarget(null);
  };

  const toggleTopic = (topicName: string) => {
    setExpandedTopics(prev => {
      const next = new Set(prev);
      if (next.has(topicName)) next.delete(topicName);
      else next.add(topicName);
      return next;
    });
  };

  const filteredQueues = mergedQueues.filter(q => q.name.toLowerCase().includes(searchTerm.toLowerCase()));
  const filteredTopics = mergedTopics.filter(t =>
    t.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    t.subscriptions.some(s => s.name.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const handleCreate = async (payload: CreateEntityPayload) => {
    if (!connection) return;
    if (payload.type === 'subscription' && !payload.topicName) {
      setCreateError('Please select a topic');
      return;
    }
    const name = payload.data.name;
    setCreating(true);
    setCreateError('');
    try {
      if (payload.type === 'queue') {
        await createQueue(connection.id, payload.data);
        setOptimisticQueues(prev => [...prev, { name, activeMessageCount: 0, deadLetterMessageCount: 0, isEmulator: connection.isEmulator, requiresSession: payload.data.requiresSession ?? false }]);
        setPendingQueues(prev => new Set(prev).add(name));
      } else if (payload.type === 'topic') {
        await createTopic(connection.id, payload.data);
        setOptimisticTopics(prev => [...prev, { name, subscriptions: [], isEmulator: connection.isEmulator }]);
        setPendingTopics(prev => new Set(prev).add(name));
      } else {
        const topicForSub = payload.topicName;
        await createSubscription(connection.id, topicForSub, payload.data);
        setOptimisticSubscriptions(prev => [...prev, { topicName: topicForSub, sub: { name, activeMessageCount: 0, deadLetterMessageCount: 0, requiresSession: payload.data.requiresSession ?? false } }]);
        setPendingSubscriptions(prev => new Set(prev).add(subscriptionKey(topicForSub, name)));
      }
      setCreateMode(null);
      setCreateTopicName('');
      onRefresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setCreating(false);
    }
  };

  const closeCreateDialog = () => {
    setCreateMode(null);
    setCreateTopicName('');
    setCreateError('');
  };

  // Delete handlers
  const openDeleteDialog = (type: EntityType, name: string, topicName?: string) => {
    setDeleteTarget({ type, name, topicName });
  };

  const closeDeleteDialog = () => {
    setDeleteTarget(null);
  };

  const handleDelete = async () => {
    if (!connection || !deleteTarget) return;
    setDeleting(true);
    const target = deleteTarget;
    try {
      if (target.type === 'queue') {
        await deleteQueue(connection.id, target.name);
        setPendingQueues(prev => new Set(prev).add(target.name));
        if (selectedEntity?.type === 'queue' && selectedEntity.name === target.name) {
          onSelectEntity(null);
        }
      } else if (target.type === 'topic') {
        await deleteTopic(connection.id, target.name);
        setPendingTopics(prev => new Set(prev).add(target.name));
        if (selectedEntity?.type === 'topic' && selectedEntity.name === target.name) {
          onSelectEntity(null);
        }
      } else if (target.type === 'subscription' && target.topicName) {
        await deleteSubscription(connection.id, target.topicName, target.name);
        setPendingSubscriptions(prev => new Set(prev).add(subscriptionKey(target.topicName!, target.name)));
        if (selectedEntity?.type === 'subscription' && selectedEntity.name === target.name) {
          onSelectEntity(null);
        }
      }
      closeDeleteDialog();
      onRefresh();
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setDeleting(false);
    }
  };

  // Wrap the edit dialog's onSaved so the edited entity is flagged pending
  // until the post-save refresh completes.
  const handleEditSaved = () => {
    if (editTarget) {
      if (editTarget.type === 'queue') {
        setPendingQueues(prev => new Set(prev).add(editTarget.name));
      } else if (editTarget.type === 'topic') {
        setPendingTopics(prev => new Set(prev).add(editTarget.name));
      } else if (editTarget.type === 'subscription' && editTarget.topicName) {
        setPendingSubscriptions(prev => new Set(prev).add(subscriptionKey(editTarget.topicName!, editTarget.name)));
      }
    }
    onRefresh();
  };

  // Close dialogs on Escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (createMode) closeCreateDialog();
      if (deleteTarget) closeDeleteDialog();
    }
  }, [createMode, deleteTarget]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleDeleteBackdropMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && e.button === 0) {
      closeDeleteDialog();
    }
  };

  if (!connection) {
    return (
      <div className="flex-1 flex items-center justify-center text-dark-500 p-4 text-center">
        <div>
          <Inbox className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>Select a connection to browse entities</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Search - fixed height matches MessagePanel header */}
      <div className={`px-4 h-[73px] ${loading ? '' : 'border-b border-dark-700'} flex items-center relative`}>
        <div className="relative flex-1" ref={searchHistoryContainerRef}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-500" />
          <input
            data-tour="entity-search"
            type="text"
            placeholder="Search entities..."
            value={searchTerm}
            onChange={e => handleSearchChange(e.target.value)}
            className="w-full pl-9 pr-14 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-white placeholder-dark-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          {searchTerm && (
            <button
              type="button"
              className="absolute right-6 top-1/2 -translate-y-1/2 p-0.5 text-dark-500 hover:text-dark-200 rounded transition-colors"
              onClick={() => {
                if (searchTerm.trim()) {
                  void saveSearchTerm(searchTerm);
                  searchDeletingRef.current = true;
                }
                setSearchTerm('');
              }}
              title="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-dark-500 hover:text-dark-200 rounded transition-colors"
            onClick={() => setSearchHistoryOpen(prev => !prev)}
            title="Search history"
          >
            <History className="w-3.5 h-3.5" />
          </button>
          {searchHistoryOpen && (
            <div className="absolute right-0 mt-1 w-full bg-dark-800 border border-dark-600 rounded-lg shadow-lg z-20 max-h-64 overflow-y-auto">
              {searchHistory.length === 0 ? (
                <div className="px-3 py-2 text-xs text-dark-400">No search history yet</div>
              ) : (
                searchHistory.map(entry => (
                  <div
                    key={entry.term}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-dark-200 hover:bg-dark-700/60"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSearchTerm(entry.term);
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
                        setFavorite(entry.term, !entry.isFavorite);
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
        {/* Loading wave replaces the border line */}
        {loading && (
          <div className="absolute bottom-0 left-0 right-0 h-[1px] overflow-hidden bg-dark-700">
            <div className="loading-wave-line h-full w-full">
              <div className="wave-sweep h-full w-full bg-gradient-to-r from-transparent via-primary-400 to-transparent" />
            </div>
          </div>
        )}
      </div>

      {/* Entity List */}
      <div data-tour="entity-list" className="flex-1 overflow-auto p-2 relative">
        {loading && queues.length === 0 && topics.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-dark-500">
            <p>Loading...</p>
          </div>
        ) : (
          <>
            {/* Queues Section */}
            <div className="mb-4">
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-xs font-semibold text-dark-400 uppercase tracking-wider">Queues</span>
                <button onClick={() => setCreateMode('queue')} className="p-1 text-dark-400 hover:text-primary-400 transition-colors" title="Create Queue">
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
              {filteredQueues.map((queue, idx) => (
                <EntityItem
                  key={queue.name}
                  icon={<Inbox className="w-4 h-4" />}
                  name={queue.name}
                  activeCount={queue.activeMessageCount}
                  deadLetterCount={queue.deadLetterMessageCount}
                  activeCountExact={queue.activeCountExact ?? true}
                  deadLetterCountExact={queue.deadLetterCountExact ?? true}
                  isSelected={selectedEntity?.type === 'queue' && selectedEntity.name === queue.name}
                  onClick={() => onSelectEntity({ type: 'queue', name: queue.name })}
                  onDelete={() => openDeleteDialog('queue', queue.name)}
                  onEdit={() => openEditDialog('queue', queue.name)}
                  pending={pendingQueues.has(queue.name)}
                  tourId={idx === 0 ? 'entity-swipe' : undefined}
                  tourSwipeAnimate={idx === 0 ? tourSwipeActive : undefined}
                />
              ))}
              {filteredQueues.length === 0 && !searchTerm && (
                <div className="text-xs text-dark-500 px-2 py-1 italic">No queues</div>
              )}
            </div>

            {/* Topics Section */}
            <div>
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-xs font-semibold text-dark-400 uppercase tracking-wider">Topics</span>
                <button onClick={() => setCreateMode('topic')} className="p-1 text-dark-400 hover:text-primary-400 transition-colors" title="Create Topic">
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
              {filteredTopics.map(topic => (
                <div key={topic.name}>
                  <TopicItem
                    name={topic.name}
                    subscriptionCount={topic.subscriptions.length}
                    isExpanded={expandedTopics.has(topic.name)}
                    isSelected={selectedEntity?.type === 'topic' && selectedEntity.name === topic.name}
                    onClick={() => {
                      onSelectEntity({ type: 'topic', name: topic.name });
                      toggleTopic(topic.name);
                    }}
                    onDelete={() => openDeleteDialog('topic', topic.name)}
                    onEdit={() => openEditDialog('topic', topic.name)}
                    onAddSubscription={() => { setCreateMode('subscription'); setCreateTopicName(topic.name); }}
                    pending={pendingTopics.has(topic.name)}
                  />
                  {expandedTopics.has(topic.name) && (
                    <div className="ml-6 border-l border-dark-700 pl-2">
                      {topic.subscriptions.map(sub => (
                        <EntityItem
                          key={sub.name}
                          icon={<Users className="w-4 h-4" />}
                          name={sub.name}
                          activeCount={sub.activeMessageCount}
                          deadLetterCount={sub.deadLetterMessageCount}
                          activeCountExact={sub.activeCountExact ?? true}
                          deadLetterCountExact={sub.deadLetterCountExact ?? true}
                          isSelected={selectedEntity?.type === 'subscription' && selectedEntity.name === sub.name && selectedEntity.topicName === topic.name}
                          onClick={() => onSelectEntity({ type: 'subscription', name: sub.name, topicName: topic.name })}
                          onDelete={() => openDeleteDialog('subscription', sub.name, topic.name)}
                          onEdit={() => openEditDialog('subscription', sub.name, topic.name)}
                          pending={pendingSubscriptions.has(subscriptionKey(topic.name, sub.name))}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {filteredTopics.length === 0 && !searchTerm && (
                <div className="text-xs text-dark-500 px-2 py-1 italic">No topics</div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Create Entity Dialog */}
      {createMode && (
        <CreateEntityDialog
          entityType={createMode}
          queues={queues}
          topics={topics}
          initialTopicName={createTopicName}
          creating={creating}
          error={createError}
          onClose={closeCreateDialog}
          onCreate={handleCreate}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onMouseDown={handleDeleteBackdropMouseDown}>
          <div className="bg-dark-800 border border-dark-600 rounded-xl w-full max-w-sm p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">
                Delete {deleteTarget.type === 'queue' ? 'Queue' : deleteTarget.type === 'topic' ? 'Topic' : 'Subscription'}
              </h3>
              <button onClick={closeDeleteDialog} className="text-dark-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-dark-300 mb-4">
              Are you sure you want to delete <span className="text-white font-medium">{deleteTarget.name}</span>? This action cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={closeDeleteDialog} className="px-3 py-1.5 bg-dark-600 hover:bg-dark-500 text-white text-sm rounded-lg">
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-3 py-1.5 bg-red-500 hover:bg-red-400 text-white text-sm rounded-lg disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Entity Dialog */}
      {editTarget && connection && (
        <EditEntityDialog
          connection={connection}
          entityType={editTarget.type}
          entityName={editTarget.name}
          topicName={editTarget.topicName}
          queues={queues}
          topics={topics}
          onClose={closeEditDialog}
          onSaved={handleEditSaved}
        />
      )}
    </div>
  );
}

interface EntityItemProps {
  icon: React.ReactNode;
  name: string;
  activeCount: number;
  deadLetterCount: number;
  // False when the count is a floor rather than a total, rendered "N+".
  activeCountExact?: boolean;
  deadLetterCountExact?: boolean;
  isSelected: boolean;
  onClick: () => void;
  onDelete: () => void;
  onEdit?: () => void;
  pending?: boolean;
  tourId?: string;
  // When true, plays an automatic back-and-forth swipe animation to demo the gesture.
  tourSwipeAnimate?: boolean;
}

function EntityItem({ icon, name, activeCount, deadLetterCount, isSelected, onClick, onDelete, onEdit, activeCountExact = true, deadLetterCountExact = true, pending, tourId, tourSwipeAnimate }: EntityItemProps) {
  if (pending) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg opacity-60 cursor-not-allowed select-none" aria-busy>
        <Loader2 className="w-4 h-4 animate-spin text-primary-400" />
        <span className="flex-1 truncate text-sm text-dark-400">{name}</span>
        <span className="text-xs bg-dark-700 px-1.5 py-0.5 rounded text-dark-500">{formatMessageCount({ count: activeCount, isExact: activeCountExact })}</span>
        <span className="text-xs bg-red-500/10 text-red-300/60 px-1.5 py-0.5 rounded">{formatMessageCount({ count: deadLetterCount, isExact: deadLetterCountExact })}</span>
      </div>
    );
  }
  const [isOpen, setIsOpen] = useState(false);
  const [, forceUpdate] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const dragXRef = useRef(0);
  const isDraggingRef = useRef(false);
  const didDragRef = useRef(false);

  const ACTION_WIDTH = 72; // Edit + Delete buttons
  const canSwipe = true;

  // Tour swipe-demo: play an automatic open → close animation to show the gesture.
  useEffect(() => {
    if (!tourSwipeAnimate || !canSwipe) return;

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const after = (ms: number, fn: () => void) => {
      const id = setTimeout(() => { if (!cancelled) fn(); }, ms);
      timers.push(id);
    };

    let acc = 0;
    const step = (delay: number, fn: () => void) => { acc += delay; after(acc, fn); };

    const runCycle = () => {
      acc = 0;
      step(500, () => {
        didDragRef.current = true;
        forceUpdate(n => n + 1);
        if (contentRef.current) {
          contentRef.current.style.transition = 'transform 380ms ease-in-out';
          contentRef.current.style.transform = `translateX(-${ACTION_WIDTH}px)`;
          dragXRef.current = -ACTION_WIDTH;
        }
      });
      step(1000, () => {
        if (contentRef.current) {
          contentRef.current.style.transition = 'transform 380ms ease-in-out';
          contentRef.current.style.transform = 'translateX(0px)';
          dragXRef.current = 0;
        }
      });
      step(400, () => {
        didDragRef.current = false;
        forceUpdate(n => n + 1);
      });
      step(700, runCycle);
    };

    runCycle();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      if (contentRef.current) {
        contentRef.current.style.transition = '';
        contentRef.current.style.transform = 'translateX(0px)';
      }
      dragXRef.current = 0;
      didDragRef.current = false;
      forceUpdate(n => n + 1);
    };
  }, [tourSwipeAnimate, canSwipe]);

  // Close when clicking outside
  useEffect(() => {
    if (!isOpen || !canSwipe) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        if (contentRef.current) {
          contentRef.current.style.transform = 'translateX(0px)';
        }
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, canSwipe]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!canSwipe) return;
    e.preventDefault();
    const currentX = isOpen ? -ACTION_WIDTH : 0;
    dragXRef.current = currentX;
    startXRef.current = e.clientX - currentX;
    isDraggingRef.current = true;
    didDragRef.current = false;
    // Don't force update here - wait for actual movement to show buttons
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!canSwipe || !isDraggingRef.current) return;
    const newX = e.clientX - startXRef.current;
    const clampedX = Math.max(-ACTION_WIDTH, Math.min(0, newX));

    // Mark as dragged if moved more than 5px
    if (Math.abs(clampedX - dragXRef.current) > 5 || Math.abs(newX - (isOpen ? -ACTION_WIDTH : 0)) > 5) {
      if (!didDragRef.current) {
        didDragRef.current = true;
        forceUpdate(n => n + 1); // Only show buttons when actual drag starts
      }
    }

    dragXRef.current = clampedX;
    if (contentRef.current) {
      contentRef.current.style.transform = `translateX(${dragXRef.current}px)`;
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!canSwipe || !isDraggingRef.current) return;

    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    isDraggingRef.current = false;

    // Snap based on current position
    const shouldOpen = dragXRef.current < -ACTION_WIDTH / 2;
    const targetX = shouldOpen ? -ACTION_WIDTH : 0;

    if (contentRef.current) {
      contentRef.current.style.transition = 'transform 200ms ease-out';
      contentRef.current.style.transform = `translateX(${targetX}px)`;
      setTimeout(() => {
        if (contentRef.current) {
          contentRef.current.style.transition = '';
        }
        // Hide buttons after animation if drawer closed
        if (!shouldOpen) {
          didDragRef.current = false;
          forceUpdate(n => n + 1);
        }
      }, 200);
    }

    dragXRef.current = targetX;
    setIsOpen(shouldOpen);
  };

  const handleClick = () => {
    // Ignore clicks that were part of a drag
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }

    if (isOpen) {
      setIsOpen(false);
      if (contentRef.current) {
        contentRef.current.style.transition = 'transform 200ms ease-out';
        contentRef.current.style.transform = 'translateX(0px)';
        setTimeout(() => {
          if (contentRef.current) {
            contentRef.current.style.transition = '';
          }
        }, 200);
      }
    } else {
      onClick();
    }
  };

  const showActions = canSwipe && (isOpen || didDragRef.current);

  // For emulator, render simple non-swipeable item
  if (!canSwipe) {
    return (
      <div
        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
          isSelected ? 'bg-primary-500/20 text-primary-400' : 'hover:bg-dark-700 text-dark-300'
        }`}
        onClick={onClick}
      >
        {icon}
        <span className="flex-1 truncate text-sm">{name}</span>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-lg" ref={containerRef} {...(tourId ? { 'data-tour': tourId } : {})}>
      {/* Action buttons behind - Edit (orange) + Delete (red) */}
      {showActions && (
        <div className="absolute right-0 top-0 bottom-0 flex">
          {onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); setIsOpen(false); if (contentRef.current) contentRef.current.style.transform = 'translateX(0px)'; onEdit(); }}
              className="w-9 h-full bg-orange-500 hover:bg-orange-400 flex items-center justify-center text-white transition-colors"
              title="Edit"
            >
              <Pencil className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setIsOpen(false); if (contentRef.current) contentRef.current.style.transform = 'translateX(0px)'; onDelete(); }}
            className="w-9 h-full bg-red-500 hover:bg-red-400 flex items-center justify-center text-white transition-colors"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Animated swipe-hint arrow shown during the tour */}
      {tourSwipeAnimate && !showActions && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-end pr-2 z-10">
          <span
            className="text-primary-300 font-bold text-base select-none"
            style={{ animation: 'tourSwipeHint 1.5s ease-in-out infinite' }}
          >
            ←
          </span>
        </div>
      )}

      {/* Main content - draggable */}
      <div
        ref={contentRef}
        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
          isSelected
            ? 'bg-[#21314e] text-primary-400'
            : (showActions ? 'bg-dark-800 text-dark-300' : 'hover:bg-dark-700 text-dark-300')
        }`}
        style={{ transform: isOpen ? `translateX(-${ACTION_WIDTH}px)` : 'translateX(0px)', touchAction: 'pan-y' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleClick}
      >
        {icon}
        <span className="flex-1 truncate text-sm">{name}</span>
        <span className="text-xs bg-dark-600 px-1.5 py-0.5 rounded">{formatMessageCount({ count: activeCount, isExact: activeCountExact })}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded ${deadLetterCount > 0 ? 'bg-red-500/20 text-red-400' : 'bg-red-500/10 text-red-300'}`}>
          {formatMessageCount({ count: deadLetterCount, isExact: deadLetterCountExact })}
        </span>
      </div>
    </div>
  );
}

interface TopicItemProps {
  name: string;
  subscriptionCount: number;
  isExpanded: boolean;
  isSelected: boolean;
  onClick: () => void;
  onDelete: () => void;
  onEdit?: () => void;
  onAddSubscription: () => void;
  pending?: boolean;
}

function TopicItem({ name, subscriptionCount, isExpanded, isSelected, onClick, onDelete, onEdit, onAddSubscription, pending }: TopicItemProps) {
  if (pending) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg opacity-60 cursor-not-allowed select-none" aria-busy>
        <ChevronRight className="w-4 h-4 text-dark-500" />
        <Loader2 className="w-4 h-4 animate-spin text-primary-400" />
        <span className="flex-1 truncate text-sm text-dark-400">{name}</span>
        <span className="text-xs text-dark-500">{subscriptionCount}</span>
      </div>
    );
  }

  const canSwipe = true;

  // For emulator, render simple non-swipeable item
  if (!canSwipe) {
    return (
      <div
        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
          isSelected ? 'bg-primary-500/20 text-primary-400' : 'hover:bg-dark-700 text-dark-300'
        }`}
        onClick={onClick}
      >
        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <MessageSquare className="w-4 h-4" />
        <span className="flex-1 truncate text-sm">{name}</span>
        <span className="text-xs text-dark-500">{subscriptionCount}</span>
      </div>
    );
  }

  // Use swipeable version for non-emulator
  return <SwipeableTopicItem
    name={name}
    subscriptionCount={subscriptionCount}
    isExpanded={isExpanded}
    isSelected={isSelected}
    onClick={onClick}
    onDelete={onDelete}
    onEdit={onEdit}
    onAddSubscription={onAddSubscription}
  />;
}

// Swipeable version of TopicItem (for non-emulator connections)
function SwipeableTopicItem({ name, subscriptionCount, isExpanded, isSelected, onClick, onDelete, onEdit, onAddSubscription }: Omit<TopicItemProps, 'isEmulator'>) {
  const [isOpen, setIsOpen] = useState(false);
  const [, forceUpdate] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const dragXRef = useRef(0);
  const isDraggingRef = useRef(false);
  const didDragRef = useRef(false);

  const ACTION_WIDTH = 72; // Edit + Delete buttons

  // Close when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        if (contentRef.current) {
          contentRef.current.style.transform = 'translateX(0px)';
        }
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const currentX = isOpen ? -ACTION_WIDTH : 0;
    dragXRef.current = currentX;
    startXRef.current = e.clientX - currentX;
    isDraggingRef.current = true;
    didDragRef.current = false;
    // Don't force update here - wait for actual movement to show buttons
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const newX = e.clientX - startXRef.current;
    const clampedX = Math.max(-ACTION_WIDTH, Math.min(0, newX));

    if (Math.abs(clampedX - dragXRef.current) > 5 || Math.abs(newX - (isOpen ? -ACTION_WIDTH : 0)) > 5) {
      if (!didDragRef.current) {
        didDragRef.current = true;
        forceUpdate(n => n + 1); // Only show buttons when actual drag starts
      }
    }

    dragXRef.current = clampedX;
    if (contentRef.current) {
      contentRef.current.style.transform = `translateX(${dragXRef.current}px)`;
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;

    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    isDraggingRef.current = false;

    const shouldOpen = dragXRef.current < -ACTION_WIDTH / 2;
    const targetX = shouldOpen ? -ACTION_WIDTH : 0;

    if (contentRef.current) {
      contentRef.current.style.transition = 'transform 200ms ease-out';
      contentRef.current.style.transform = `translateX(${targetX}px)`;
      setTimeout(() => {
        if (contentRef.current) {
          contentRef.current.style.transition = '';
        }
        // Hide buttons after animation if drawer closed
        if (!shouldOpen) {
          didDragRef.current = false;
          forceUpdate(n => n + 1);
        }
      }, 200);
    }

    dragXRef.current = targetX;
    setIsOpen(shouldOpen);
  };

  const handleClick = () => {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }

    if (isOpen) {
      setIsOpen(false);
      if (contentRef.current) {
        contentRef.current.style.transition = 'transform 200ms ease-out';
        contentRef.current.style.transform = 'translateX(0px)';
        setTimeout(() => {
          if (contentRef.current) {
            contentRef.current.style.transition = '';
          }
        }, 200);
      }
    } else {
      onClick();
    }
  };

  const showActions = isOpen || didDragRef.current;

  return (
    <div className="relative overflow-hidden rounded-lg" ref={containerRef}>
      {/* Action buttons behind - Edit (orange) + Delete (red) */}
      {showActions && (
        <div className="absolute right-0 top-0 bottom-0 flex">
          {onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); setIsOpen(false); if (contentRef.current) contentRef.current.style.transform = 'translateX(0px)'; onEdit(); }}
              className="w-9 h-full bg-orange-500 hover:bg-orange-400 flex items-center justify-center text-white transition-colors"
              title="Edit"
            >
              <Pencil className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setIsOpen(false); if (contentRef.current) contentRef.current.style.transform = 'translateX(0px)'; onDelete(); }}
            className="w-9 h-full bg-red-500 hover:bg-red-400 flex items-center justify-center text-white transition-colors"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Main content - draggable */}
      <div
        ref={contentRef}
        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
          isSelected
            ? 'bg-[#21314e] text-primary-400'
            : (showActions ? 'bg-dark-800 text-dark-300' : 'hover:bg-dark-700 text-dark-300')
        }`}
        style={{ transform: isOpen ? `translateX(-${ACTION_WIDTH}px)` : 'translateX(0px)', touchAction: 'pan-y' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleClick}
      >
        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <MessageSquare className="w-4 h-4" />
        <span className="flex-1 truncate text-sm">{name}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onAddSubscription(); }}
          className="p-0.5 text-dark-500 hover:text-primary-400 transition-colors"
          title="Add Subscription"
        >
          <Plus className="w-3 h-3" />
        </button>
        <span className="text-xs text-dark-500">{subscriptionCount}</span>
      </div>
    </div>
  );
}
