import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Plus, Trash2, Edit2, Save, Database, ChevronsUpDown } from 'lucide-react';
import type { Connection } from '../types';
import { getConnections, createConnection, updateConnection, deleteConnection, reorderConnections } from '../api/client';

// Touch devices get long-press-to-drag on the whole row; pointer devices get a grip button.
function useIsTouch() {
  const [isTouch, setIsTouch] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const handler = () => setIsTouch(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isTouch;
}

interface ConnectionManagerProps {
  onClose: () => void;
}

export default function ConnectionManager({ onClose }: ConnectionManagerProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [formData, setFormData] = useState({ name: '', connectionString: '' });
  const [error, setError] = useState('');
  const [draggingId, setDraggingId] = useState<number | null>(null);

  const isTouch = useIsTouch();

  // Refs used during a drag so pointer handlers see live values without re-subscribing.
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const dragStartOrderRef = useRef<number[]>([]);
  const pointerIdRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);

  // Close on Escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Close when a click starts on the backdrop (mousedown, so a drag that
  // starts inside the dialog and ends outside doesn't close it)
  const handleBackdropMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && e.button === 0) {
      onClose();
    }
  };

  const loadData = async () => {
    try {
      setConnections(await getConnections());
    } catch (err) {
      console.error('Failed to load data:', err);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSave = async () => {
    if (!formData.name || !formData.connectionString) {
      setError('Name and connection string are required');
      return;
    }
    setError('');
    try {
      if (editingId) {
        await updateConnection(editingId, formData);
      } else {
        await createConnection(formData);
      }
      await loadData();
      setIsAdding(false);
      setEditingId(null);
      setFormData({ name: '', connectionString: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const handleEdit = (conn: Connection) => {
    setEditingId(conn.id);
    setFormData({ name: conn.name, connectionString: conn.connectionString });
    setIsAdding(false);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this connection?')) return;
    try {
      await deleteConnection(id);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const handleAdd = () => {
    setIsAdding(true);
    setEditingId(null);
    setFormData({ name: '', connectionString: '' });
  };

  const handleCancel = () => {
    setIsAdding(false);
    setEditingId(null);
    setFormData({ name: '', connectionString: '' });
    setError('');
  };

  // --- Drag-to-reorder ---------------------------------------------------

  const clearLongPress = () => {
    if (longPressTimerRef.current != null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const beginDrag = (id: number) => {
    dragStartOrderRef.current = connectionsRef.current.map(c => c.id);
    setDraggingId(id);
  };

  // Reorder the live list so the dragged row follows the pointer.
  const reorderToPointer = useCallback((draggedId: number, pointerY: number) => {
    const current = connectionsRef.current;
    const dragged = current.find(c => c.id === draggedId);
    if (!dragged) return;

    const others = current.filter(c => c.id !== draggedId);
    let insertAt = others.length;
    for (let i = 0; i < others.length; i++) {
      const el = rowRefs.current.get(others[i].id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (pointerY < rect.top + rect.height / 2) {
        insertAt = i;
        break;
      }
    }

    const next = [...others];
    next.splice(insertAt, 0, dragged);
    if (next.some((c, i) => c.id !== current[i].id)) {
      setConnections(next);
    }
  }, []);

  const endDrag = useCallback(async () => {
    const draggedId = draggingId;
    setDraggingId(null);
    pointerIdRef.current = null;
    if (draggedId == null) return;

    const newOrder = connectionsRef.current.map(c => c.id);
    const startOrder = dragStartOrderRef.current;
    const changed = newOrder.length !== startOrder.length || newOrder.some((id, i) => id !== startOrder[i]);
    if (!changed) return;

    try {
      await reorderConnections(newOrder);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save order');
      await loadData(); // fall back to the persisted order
    }
  }, [draggingId]);

  // Track the pointer for the duration of a drag.
  useEffect(() => {
    if (draggingId == null) return;

    const handleMove = (e: PointerEvent) => {
      e.preventDefault();
      reorderToPointer(draggingId, e.clientY);
    };
    const handleUp = () => { endDrag(); };

    window.addEventListener('pointermove', handleMove, { passive: false });
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [draggingId, reorderToPointer, endDrag]);

  // Grip button (pointer devices): press-and-hold starts the drag immediately.
  const handleGripPointerDown = (e: React.PointerEvent, id: number) => {
    e.preventDefault();
    pointerIdRef.current = e.pointerId;
    beginDrag(id);
  };

  // Row long-press (touch devices): a held press starts the drag.
  const handleRowPointerDown = (e: React.PointerEvent, id: number) => {
    if (!isTouch || editingId != null) return;
    pointerIdRef.current = e.pointerId;
    clearLongPress();
    longPressTimerRef.current = window.setTimeout(() => beginDrag(id), 350);
  };

  const handleRowPointerLeaveOrUp = () => {
    // Cancel a pending long-press if the finger lifts/moves off before it fires.
    if (draggingId == null) clearLongPress();
  };

  useEffect(() => clearLongPress, []);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onMouseDown={handleBackdropMouseDown}>
      <div className="bg-dark-800 border border-dark-600 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-dark-600">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Database className="w-5 h-5 text-primary-400" />
            Manage Connections
          </h2>
          <button onClick={onClose} className="text-dark-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">{error}</div>
          )}

          {/* Connection List */}
          <div className="space-y-2 mb-4">
            {connections.map(conn => {
              const isDragging = draggingId === conn.id;
              return (
              <div
                key={conn.id}
                ref={el => { if (el) rowRefs.current.set(conn.id, el); else rowRefs.current.delete(conn.id); }}
                onPointerDown={e => handleRowPointerDown(e, conn.id)}
                onPointerUp={handleRowPointerLeaveOrUp}
                onPointerLeave={handleRowPointerLeaveOrUp}
                style={{ touchAction: isTouch && editingId == null ? 'none' : undefined }}
                className={`p-3 rounded-lg border transition-transform ${editingId === conn.id ? 'border-primary-500 bg-primary-500/10' : 'border-dark-600 bg-dark-700/50'} ${isDragging ? 'scale-[1.02] shadow-lg shadow-black/40 border-primary-500 relative z-10 select-none' : ''} ${draggingId != null && !isDragging ? 'opacity-60' : ''}`}
              >
                {editingId === conn.id ? (
                  <ConnectionForm formData={formData} setFormData={setFormData} onSave={handleSave} onCancel={handleCancel} />
                ) : (
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="font-medium text-white">{conn.name}</div>
                      <div className="text-sm text-dark-400 truncate max-w-md">{conn.connectionString.substring(0, 50)}...</div>
                      {conn.isEmulator && <span className="text-xs text-purple-400">Emulator</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      {!isTouch && (
                        <button
                          onPointerDown={e => handleGripPointerDown(e, conn.id)}
                          title="Hold and drag to reorder"
                          aria-label="Reorder connection"
                          className={`p-1.5 text-dark-400 hover:text-primary-400 transition-colors touch-none ${isDragging ? 'cursor-grabbing text-primary-400' : 'cursor-grab'}`}
                        >
                          <ChevronsUpDown className="w-4 h-4" />
                        </button>
                      )}
                      <button onClick={() => handleEdit(conn)} className="p-1.5 text-dark-400 hover:text-primary-400 transition-colors">
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleDelete(conn.id)} className="p-1.5 text-dark-400 hover:text-red-400 transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </div>

          {/* Add New Connection */}
          {isAdding ? (
            <div className="p-3 rounded-lg border border-primary-500 bg-primary-500/10">
              <ConnectionForm formData={formData} setFormData={setFormData} onSave={handleSave} onCancel={handleCancel} />
            </div>
          ) : (
            <button onClick={handleAdd} className="w-full p-3 border border-dashed border-dark-500 rounded-lg text-dark-400 hover:text-white hover:border-primary-500 transition-colors flex items-center justify-center gap-2">
              <Plus className="w-4 h-4" /> Add Connection
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface ConnectionFormProps {
  formData: { name: string; connectionString: string };
  setFormData: React.Dispatch<React.SetStateAction<{ name: string; connectionString: string }>>;
  onSave: () => void;
  onCancel: () => void;
}

function ConnectionForm({ formData, setFormData, onSave, onCancel }: ConnectionFormProps) {
  return (
    <div className="space-y-3">
      <input type="text" placeholder="Connection Name" value={formData.name} onChange={e => setFormData(d => ({ ...d, name: e.target.value }))} className="w-full px-3 py-2 bg-dark-900 border border-dark-500 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
      <input type="text" placeholder="Connection String" value={formData.connectionString} onChange={e => setFormData(d => ({ ...d, connectionString: e.target.value }))} className="w-full px-3 py-2 bg-dark-900 border border-dark-500 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
      <p className="text-xs text-dark-400">
        Connections containing <code>UseDevelopmentEmulator=true</code> use the emulator management API.
      </p>
      <div className="flex gap-2">
        <button onClick={onSave} className="px-3 py-1.5 bg-primary-500 hover:bg-primary-400 text-white text-sm rounded-lg flex items-center gap-1"><Save className="w-3.5 h-3.5" /> Save</button>
        <button onClick={onCancel} className="px-3 py-1.5 bg-dark-600 hover:bg-dark-500 text-white text-sm rounded-lg">Cancel</button>
      </div>
    </div>
  );
}
