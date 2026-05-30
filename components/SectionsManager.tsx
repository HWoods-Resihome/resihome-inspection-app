/**
 * SectionsManager — modal for bulk section operations.
 *
 * Lets the inspector:
 *  - Rename sections (inline edit each row)
 *  - Delete sections (X button per row)
 *  - Reorder sections (drag-and-drop, native HTML5 DnD — no library)
 *  - Add a new custom section (free-form text input + Add button)
 *  - Clear a room's content (eraser per row) or every room ("Clear All"),
 *    wiping its lines + photos but keeping the room. These are STAGED: the
 *    rows preview "0 lines · 0 photos" immediately, but nothing is persisted
 *    until the user hits Done (no confirmation prompts).
 *
 * Rename / delete / add / reorder still fire immediately on action. Only the
 * clear actions are deferred until Done.
 *
 * Drag-and-drop uses native HTML5 events. We track a `dropLineIndex` (the gap
 * the dragged row will land in) and render a thin line BETWEEN rows at that
 * gap, rather than highlighting the hovered row.
 */
import { Fragment, useState } from 'react';
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
  // Apply staged "clear content" actions for these section ids (lines + photos).
  onClearSections: (sectionIds: string[]) => void;
}

export function SectionsManager(props: Props) {
  const [draftNew, setDraftNew] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  // Drag-and-drop state. `dropLineIndex` is the GAP index (0..length) where the
  // dragged row will be inserted — rendered as a line between rows.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropLineIndex, setDropLineIndex] = useState<number | null>(null);
  // Sections staged to have their content cleared on Done.
  const [pendingClear, setPendingClear] = useState<Set<string>>(new Set());

  const allCleared = props.sections.length > 0 && props.sections.every((s) => pendingClear.has(s.id));

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

  function togglePendingClear(id: string) {
    setPendingClear((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function handleClearAll() {
    setPendingClear(allCleared ? new Set() : new Set(props.sections.map((s) => s.id)));
  }

  // Done applies any staged clears, then closes. Closing via the × or the
  // backdrop discards staged clears (acts as a cancel for them).
  function handleDone() {
    if (pendingClear.size > 0) props.onClearSections(Array.from(pendingClear));
    props.onClose();
  }

  function handleDragStart(idx: number) {
    setDragIndex(idx);
  }
  function handleDragOver(idx: number, e: React.DragEvent) {
    e.preventDefault();   // required to allow drop
    if (dragIndex == null) return;
    // Insert before this row if the cursor is in its top half, else after.
    const rect = e.currentTarget.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    setDropLineIndex(before ? idx : idx + 1);
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    if (dragIndex != null && dropLineIndex != null) {
      const from = dragIndex;
      let to = dropLineIndex;
      // No-op if dropping back into its own slot.
      if (to !== from && to !== from + 1) {
        const next = [...props.sections];
        const [moved] = next.splice(from, 1);
        if (to > from) to -= 1;   // account for the removed item
        next.splice(to, 0, moved);
        props.onReorder(next);
      }
    }
    setDragIndex(null);
    setDropLineIndex(null);
  }
  function handleDragEnd() {
    setDragIndex(null);
    setDropLineIndex(null);
  }

  const DropLine = () => (
    <li aria-hidden className="h-0.5 -my-0.5 bg-brand rounded pointer-events-none" />
  );

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
            Drag to reorder. Pencil renames, the eraser clears a room&apos;s lines &amp;
            photos, the × deletes the room. Clears apply when you hit Done.
          </div>

          <ul className="space-y-1">
            {props.sections.map((s, idx) => {
              const isDragging = dragIndex === idx;
              const lineCount = props.lineCounts[s.id] || 0;
              const photoCount = props.photoCounts[s.id] || 0;
              const isEditing = editingId === s.id;
              const cleared = pendingClear.has(s.id);
              const hasContent = lineCount > 0 || photoCount > 0;
              return (
                <Fragment key={s.id}>
                  {dropLineIndex === idx && <DropLine />}
                  <li
                    draggable={!isEditing}
                    onDragStart={() => handleDragStart(idx)}
                    onDragOver={(e) => handleDragOver(idx, e)}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                    className={`flex items-center gap-2 px-2 py-2 rounded border ${
                      isDragging ? 'opacity-40 border-gray-200' : 'border-gray-200 hover:bg-gray-50'
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
                          {cleared ? (
                            <span className="text-xs text-amber-600 font-medium flex-shrink-0">0 lines · 0 photos</span>
                          ) : hasContent && (
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
                          onClick={() => togglePendingClear(s.id)}
                          disabled={!hasContent && !cleared}
                          className={`p-1 disabled:opacity-30 disabled:cursor-not-allowed ${
                            cleared ? 'text-amber-600' : 'text-gray-400 hover:text-amber-600'
                          }`}
                          title={cleared ? 'Cleared — tap to keep its lines & photos' : 'Clear this room’s lines & photos'}
                          aria-label="Clear room content"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                            <path d="M22 21H7" />
                            <path d="m5 11 9 9" />
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
                </Fragment>
              );
            })}
            {dropLineIndex === props.sections.length && <DropLine />}
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

        <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleClearAll}
            className="px-4 py-2 text-sm font-heading font-semibold rounded border border-amber-300 text-amber-700 hover:bg-amber-50"
            title="Stage every room to have its lines & photos cleared on Done"
          >
            {allCleared ? 'Undo Clear All' : 'Clear All'}
          </button>
          <button
            type="button"
            onClick={handleDone}
            className="px-5 py-2 text-sm bg-brand text-white font-heading font-semibold rounded hover:bg-brand-dark"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
