/**
 * SectionsManager — modal for bulk section operations.
 *
 * Lets the inspector:
 *  - Rename sections (inline edit each row)
 *  - Delete sections (X button per row, with confirm)
 *  - Reorder sections (drag-and-drop, native HTML5 DnD — no library)
 *  - Add a new custom section (free-form text input + Add button)
 *
 * The component is "controlled" via callbacks back to the host form; it never
 * mutates state directly. Each callback fires immediately on user action, so
 * the modal can stay open and the host form re-renders to reflect changes.
 *
 * Drag-and-drop uses native HTML5 events. We track dragOverIndex separately
 * from dragIndex so we can show a visual drop indicator BETWEEN rows while
 * still computing the final insertion point on drop.
 */
import { useState } from 'react';
import { type SectionInstance, titleCaseSectionName } from '@/lib/sections';

interface Props {
  sections: SectionInstance[];
  lineCounts: Record<string, number>;
  photoCounts: Record<string, number>;
  onClose: () => void;
  onRename: (sectionId: string, newLabel: string) => void;
  onDelete: (sectionId: string) => void;
  onAdd: (label: string) => void;
  onReorder: (next: SectionInstance[]) => void;
}

export function SectionsManager(props: Props) {
  const [draftNew, setDraftNew] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  // Drag-and-drop state — by index, so we can insert at the right slot
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  function startEdit(s: SectionInstance) {
    setEditingId(s.id);
    setEditingDraft(s.label);
  }
  function commitEdit() {
    if (editingId == null) return;
    const cleaned = titleCaseSectionName(editingDraft);
    if (cleaned) props.onRename(editingId, cleaned);
    setEditingId(null);
    setEditingDraft('');
  }
  function cancelEdit() {
    setEditingId(null);
    setEditingDraft('');
  }

  function handleAdd() {
    const cleaned = titleCaseSectionName(draftNew);
    if (!cleaned) return;
    props.onAdd(cleaned);
    setDraftNew('');
  }

  function handleDragStart(idx: number) {
    setDragIndex(idx);
  }
  function handleDragOver(idx: number, e: React.DragEvent) {
    e.preventDefault();   // required to allow drop
    if (dragIndex == null || idx === dragIndex) return;
    setDragOverIndex(idx);
  }
  function handleDragLeave() {
    // No-op — clearing dragOverIndex on each leave makes the indicator flicker
    // when moving between rows. We just let the next dragOver update it.
  }
  function handleDrop(idx: number, e: React.DragEvent) {
    e.preventDefault();
    if (dragIndex == null || idx === dragIndex) {
      setDragIndex(null); setDragOverIndex(null); return;
    }
    const next = [...props.sections];
    const [moved] = next.splice(dragIndex, 1);
    // Adjust target index if we removed an earlier item before the drop
    const insertAt = idx > dragIndex ? idx - 1 : idx;
    next.splice(insertAt, 0, moved);
    props.onReorder(next);
    setDragIndex(null);
    setDragOverIndex(null);
  }
  function handleDragEnd() {
    setDragIndex(null);
    setDragOverIndex(null);
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={props.onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">Manage Sections</h2>
          <button onClick={props.onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">×</button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          <div className="text-xs text-gray-500 mb-3">
            Drag to reorder. Click the pencil to rename. The × deletes the section
            and its saved lines/photos.
          </div>

          <ul className="space-y-1">
            {props.sections.map((s, idx) => {
              const isDragging = dragIndex === idx;
              const isDragOver = dragOverIndex === idx && dragIndex !== null && dragIndex !== idx;
              const lineCount = props.lineCounts[s.id] || 0;
              const photoCount = props.photoCounts[s.id] || 0;
              const isEditing = editingId === s.id;
              return (
                <li
                  key={s.id}
                  draggable={!isEditing}
                  onDragStart={() => handleDragStart(idx)}
                  onDragOver={(e) => handleDragOver(idx, e)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(idx, e)}
                  onDragEnd={handleDragEnd}
                  className={`flex items-center gap-2 px-2 py-2 rounded border ${
                    isDragOver ? 'border-brand border-2 bg-brand/5'
                              : isDragging ? 'opacity-40 border-gray-200'
                              : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {/* Drag handle */}
                  <div className="cursor-grab text-gray-400 select-none px-1" title="Drag to reorder">⋮⋮</div>

                  {/* Label (display or editing) */}
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <input
                        value={editingDraft}
                        onChange={(e) => setEditingDraft(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                          else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                        }}
                        autoFocus
                        className="w-full border border-brand rounded px-2 py-1 text-sm"
                      />
                    ) : (
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium text-sm text-ink truncate">{s.displayName}</span>
                        {s.isCustom && (
                          <span className="text-[10px] uppercase tracking-wide text-violet-600 font-semibold flex-shrink-0">Custom</span>
                        )}
                        {(lineCount > 0 || photoCount > 0) && (
                          <span className="text-xs text-gray-500 flex-shrink-0">
                            {lineCount > 0 && `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`}
                            {lineCount > 0 && photoCount > 0 && ' · '}
                            {photoCount > 0 && `${photoCount} ${photoCount === 1 ? 'photo' : 'photos'}`}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  {!isEditing && (
                    <>
                      <button
                        type="button"
                        onClick={() => startEdit(s)}
                        className="text-gray-400 hover:text-brand p-1"
                        title="Rename"
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 1.5l3.5 3.5L5 14.5H1.5V11L11 1.5z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => props.onDelete(s.id)}
                        className="text-gray-400 hover:text-red-600 p-1 text-base leading-none"
                        title="Delete"
                      >
                        ×
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          {/* Add new section */}
          <div className="mt-4 pt-4 border-t border-gray-200">
            <label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
              Add New Section
            </label>
            <div className="flex gap-2 mt-2">
              <input
                value={draftNew}
                onChange={(e) => setDraftNew(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
                placeholder="e.g., Pool House, Detached Garage, Workshop"
                className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={handleAdd}
                disabled={!draftNew.trim()}
                className="px-4 py-2 text-sm bg-brand text-white font-semibold rounded hover:bg-brand-dark disabled:bg-gray-300"
              >
                Add
              </button>
            </div>
            <div className="text-xs text-gray-500 mt-1">
              Typing &quot;sun room&quot; will be saved as &quot;Sun Room&quot;.
            </div>
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-gray-200 flex justify-end">
          <button
            type="button"
            onClick={props.onClose}
            className="px-5 py-2 text-sm bg-brand text-white font-heading font-semibold rounded hover:bg-brand-dark"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
