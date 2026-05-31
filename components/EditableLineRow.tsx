/**
 * EditableLineRow — the workhorse of the Rate Card form.
 *
 * Two states:
 *   - VIEW: read-only display of a saved line. Click anywhere on the row to edit.
 *   - EDIT: inline dropdowns / inputs in each cell. The row is its own "form".
 *           - Click outside → auto-save (if all required fields filled).
 *           - Enter → blur the focused field → triggers save.
 *           - Esc → revert and exit edit mode. If this was a new row that was
 *                   never saved, the row vanishes.
 *           - Required: line item code + quantity > 0 + vendor.
 *
 * Columns (final order, matches the v0.16.3 header):
 *   Cat | Sub | Line Item | Qty | Unit | Vendor | Vendor $ | Client $ | Ten % | Tenant $ | Actions
 *
 * All data cells use a uniform text-sm size for visual consistency.
 *
 * For NEW (unsaved) rows passed in via `mode === 'new'`, the row mounts already
 * in edit mode. For saved rows, the row mounts in view mode and transitions on
 * click. The parent supplies an `onSave` callback for both add and edit paths.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { depKindForCategory, depreciationTenantPct } from '@/lib/depreciation';
import { Combobox } from '@/components/Combobox';
import { calculateLine, roundMoney } from '@/lib/rateCardMath';
import { formatMoney } from '@/lib/photoUpload';
import { displayImageSrc } from '@/lib/photoDisplay';
import { isVideoEntry } from '@/lib/media';
import { VENDORS, vendorPillStyle } from '@/lib/vendors';
import type {
  RateCardLineItem,
  RegionRate,
  RateCardLineInput,
} from '@/lib/types';

/**
 * Feature flag for the math debug panel. Set to true to reveal the yellow
 * formula-trace row beneath each line item while editing (handy when the
 * vendor cost looks wrong and you need to see the labor/material breakdown).
 * Off by default since the math is validated.
 */
const SHOW_MATH_DEBUG = false;

interface Props {
  // Line data and metadata
  line: RateCardLineInput | null;       // null means "brand new, unsaved"
  catalog: RateCardLineItem[];
  regions: RegionRate[];
  inspectionRegion: string;
  // Section context (used when saving a new row)
  section: string;
  location: string;
  // When set (Whole House sections), a newly-picked SF-measured item defaults
  // its quantity to this (the property square footage) instead of 1.
  autoSfQuantity?: number | null;
  // Tenant's months in the home — auto-sets the tenant % on paint/flooring lines
  // per the depreciation schedule (new rows only, until manually changed).
  tenantMonths?: number | null;
  // Behavior
  readOnly?: boolean;
  startInEditMode?: boolean;            // true for new rows
  // When true, edit mode renders a full-screen mobile-friendly card (stacked
  // fields) instead of the inline <tr>. View mode is unchanged.
  mobile?: boolean;
  // Callbacks
  onSave: (line: RateCardLineInput) => void;
  onDelete: () => void;                 // hide × in view mode? no — always shown
  onDiscardNew?: () => void;            // for new rows that never get saved
  // Open the line's tagged photo at `index` in the lightbox.
  onOpenPhoto?: (index: number) => void;
  // Reports when this row's edit modal opens/closes (so the parent can hide the
  // floating mic while a line modal is up).
  onEditingChange?: (editing: boolean) => void;
}

const TENANT_PCT_OPTIONS = Array.from({ length: 21 }, (_, i) => i * 5);
// Default vendor selection when a new line is created. The VENDORS list itself
// is ordered with "Internal Resolution" first (it's the most common selection
// AT SAVE TIME, not the most common DEFAULT). For the dropdown's pre-selected
// value on a brand-new row, "Vendor 1" is the right default — inspectors more
// often have a specific external vendor in mind when adding a line and would
// reach to change it anyway.
const DEFAULT_VENDOR = 'Vendor 1';
const DEFAULT_TENANT_PCT = 100;

function genExternalId(): string {
  // crypto.randomUUID is available in all modern browsers + Node 18+.
  const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `RCLINE-${uuid}`;
}

/**
 * The default description to show for a catalog item. Prefers the newer
 * per-item labor_subtext; falls back to the legacy full description for any
 * item that doesn't have a subtext yet. (A user's own per-line override always
 * takes precedence over this where applicable.)
 */
function catalogDescription(item: { laborSubtext?: string; laborFullDescription: string }): string {
  return (item.laborSubtext && item.laborSubtext.trim()) || item.laborFullDescription || '';
}

export function EditableLineRow(props: Props) {
  const {
    line, catalog, regions, inspectionRegion,
    section, location, readOnly, startInEditMode, mobile,
    onSave, onDelete, onDiscardNew, autoSfQuantity, tenantMonths,
  } = props;

  // -------------------------------------------------------------------
  // Mode state
  // -------------------------------------------------------------------
  const [isEditing, setIsEditing] = useState<boolean>(startInEditMode === true);

  // Tell the parent whenever the edit modal opens/closes (and on unmount), so it
  // can hide the floating mic while a line modal is up.
  const onEditingChangeRef = useRef(props.onEditingChange);
  onEditingChangeRef.current = props.onEditingChange;
  useEffect(() => { onEditingChangeRef.current?.(isEditing); }, [isEditing]);
  useEffect(() => () => { onEditingChangeRef.current?.(false); }, []);

  // -------------------------------------------------------------------
  // Local form state (mirrors the line during editing). Updated from
  // `line` whenever we ENTER edit mode (not on every render — that would
  // overwrite user input on autosave round-trips).
  // -------------------------------------------------------------------
  const [lineItemCode, setLineItemCode] = useState<string>(line?.lineItemCode || '');
  const [category, setCategory] = useState<string>('');
  const [subcategory, setSubcategory] = useState<string>('');
  const [quantity, setQuantity] = useState<string>(line?.quantity != null ? String(line.quantity) : '1');
  const [tenantPct, setTenantPct] = useState<number>(line?.tenantBillBackPercent ?? DEFAULT_TENANT_PCT);
  const [vendor, setVendor] = useState<string>(line?.assignedTo || DEFAULT_VENDOR);
  const [customVendorCost, setCustomVendorCost] = useState<string>(
    line?.customVendorCost != null ? String(line.customVendorCost) : ''
  );
  // Editable full labor description. Initialized to whatever the line already
  // has (custom override or empty). The placeholder shows the catalog default
  // so the inspector knows what the falsy state will resolve to.
  const [customDescription, setCustomDescription] = useState<string>(
    line?.customLaborFullDescription || ''
  );

  // Initialize category/subcategory from catalog lookup when entering edit mode
  // or on first mount of an existing line.
  useEffect(() => {
    if (!line?.lineItemCode || catalog.length === 0) return;
    const item = catalog.find((c) => c.lineItemCode === line.lineItemCode);
    if (item) {
      setCategory(item.category);
      setSubcategory(item.subcategory);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line?.lineItemCode, catalog.length]);

  // -------------------------------------------------------------------
  // Track the row container so we can detect "clicked outside" for autosave
  // -------------------------------------------------------------------
  const rowRef = useRef<HTMLTableRowElement | null>(null);

  // -------------------------------------------------------------------
  // Derived filter lists
  // -------------------------------------------------------------------
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const item of catalog) {
      if (item.category) set.add(item.category);
    }
    return Array.from(set).sort();
  }, [catalog]);

  const subcategories = useMemo(() => {
    const set = new Set<string>();
    for (const item of catalog) {
      if (category && item.category !== category) continue;
      if (item.subcategory) set.add(item.subcategory);
    }
    // "Bid Item" always first, then alphabetical
    return Array.from(set).sort((a, b) => {
      if (a === 'Bid Item' && b !== 'Bid Item') return -1;
      if (a !== 'Bid Item' && b === 'Bid Item') return 1;
      return a.localeCompare(b);
    });
  }, [catalog, category]);

  const filteredLineItems = useMemo(() => {
    return catalog
      .filter((item) => {
        if (category && item.category !== category) return false;
        if (subcategory && item.subcategory !== subcategory) return false;
        return true;
      })
      .sort((a, b) => a.laborShortDescription.localeCompare(b.laborShortDescription));
  }, [catalog, category, subcategory]);

  const selectedItem: RateCardLineItem | null = useMemo(() => {
    if (!lineItemCode) return null;
    return catalog.find((c) => c.lineItemCode === lineItemCode) || null;
  }, [catalog, lineItemCode]);

  // Whole House + SF item on a NEW row: default the quantity to the property
  // square footage (instead of 1) so the inspector doesn't have to type it.
  // Only when the quantity is still the untouched default.
  useEffect(() => {
    if (line) return; // existing rows keep their saved quantity
    if (!selectedItem) return;
    if (!autoSfQuantity || autoSfQuantity <= 0) return;
    if (!/^sf$/i.test((selectedItem.laborMeas || '').trim())) return;
    setQuantity((q) => (q === '1' || q.trim() === '' ? String(autoSfQuantity) : q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItem, autoSfQuantity]);

  // Paint/flooring depreciation: on a NEW row, default the tenant % from the
  // schedule (by the tenant's months in home) when a paint/flooring item is
  // picked — until the inspector changes it manually.
  const tenantTouchedRef = useRef(false);
  useEffect(() => {
    if (line) return;                 // existing rows keep their saved %
    if (tenantTouchedRef.current) return;
    if (!selectedItem) return;
    const kind = depKindForCategory(selectedItem.category, selectedItem.laborShortDescription);
    if (!kind) return;
    setTenantPct(depreciationTenantPct(kind, typeof tenantMonths === 'number' ? tenantMonths : 12));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItem, tenantMonths]);

  // Editable description: prefill with the catalog default (as real, clearable
  // text) when an item is picked, unless the inspector has edited it or the line
  // already carries a saved override. This makes delete-and-retype work — the
  // field is no longer pinned to the catalog text via a display fallback.
  const descTouchedRef = useRef(!!(line?.customLaborFullDescription));
  useEffect(() => {
    if (descTouchedRef.current) return;
    if (!selectedItem) return;
    setCustomDescription(catalogDescription(selectedItem));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItem]);

  // -------------------------------------------------------------------
  // Live calculation
  // -------------------------------------------------------------------
  const quantityNum = Number(quantity);
  const validQuantity = isFinite(quantityNum) && quantityNum > 0;

  const calc = useMemo(() => {
    if (!selectedItem || !validQuantity || regions.length === 0) return null;
    try {
      return calculateLine(selectedItem, inspectionRegion, regions, {
        quantity: quantityNum,
        tenantBillBackPercent: tenantPct,
        customLaborRate: line?.customLaborRate ?? null,
        customAdjustedMaterialCost: line?.customAdjustedMaterialCost ?? null,
        customVendorCost: customVendorCost.trim() === '' ? null : Number(customVendorCost),
      });
    } catch {
      return null;
    }
  }, [selectedItem, inspectionRegion, regions, quantityNum, validQuantity, tenantPct, customVendorCost, line?.customLaborRate, line?.customAdjustedMaterialCost]);

  // -------------------------------------------------------------------
  // Cascade handlers
  // -------------------------------------------------------------------
  function handleLineItemChange(code: string) {
    setLineItemCode(code);
    if (code) {
      const item = catalog.find((c) => c.lineItemCode === code);
      if (item) {
        setCategory(item.category);
        setSubcategory(item.subcategory);
      }
    }
  }

  function handleCategoryChange(cat: string) {
    setCategory(cat);
    if (selectedItem && selectedItem.category !== cat) {
      setLineItemCode('');
      setSubcategory('');
    }
  }

  function handleSubcategoryChange(sub: string) {
    setSubcategory(sub);
    if (selectedItem && selectedItem.subcategory !== sub) {
      setLineItemCode('');
    }
  }

  // -------------------------------------------------------------------
  // Save / cancel
  // -------------------------------------------------------------------
  const isComplete = !!selectedItem && validQuantity && vendor.length > 0;

  function trySave() {
    if (!isComplete || !selectedItem) {
      // For a new row that never got filled out, discard it.
      if (!line && onDiscardNew) onDiscardNew();
      setIsEditing(false);
      return;
    }
    const next: RateCardLineInput = {
      externalId: line?.externalId || genExternalId(),
      section: line?.section || section,
      location: line?.location || location,
      lineItemCode: selectedItem.lineItemCode,
      quantity: quantityNum,
      tenantBillBackPercent: tenantPct,
      assignedTo: vendor,
      note: line?.note || '',
      customLaborRate: line?.customLaborRate ?? null,
      customAdjustedMaterialCost: line?.customAdjustedMaterialCost ?? null,
      customVendorCost: customVendorCost.trim() === '' ? null : Number(customVendorCost),
      photoUrls: line?.photoUrls || [],
      // Store an override only when it's non-empty AND differs from the catalog
      // default (so an unedited prefill isn't persisted as a custom override).
      customLaborFullDescription: (() => {
        const d = customDescription.trim();
        if (!d) return undefined;
        return d === catalogDescription(selectedItem).trim() ? undefined : d;
      })(),
    };
    onSave(next);
    setIsEditing(false);
  }

  function cancelEdit() {
    if (!line && onDiscardNew) {
      onDiscardNew();
      return;
    }
    // Revert local state to the saved values
    setLineItemCode(line?.lineItemCode || '');
    setQuantity(line?.quantity ? String(line.quantity) : '1');
    setTenantPct(line?.tenantBillBackPercent ?? DEFAULT_TENANT_PCT);
    setVendor(line?.assignedTo || DEFAULT_VENDOR);
    setCustomVendorCost(line?.customVendorCost != null ? String(line.customVendorCost) : '');
    setCustomDescription(line?.customLaborFullDescription || '');
    const item = line?.lineItemCode ? catalog.find((c) => c.lineItemCode === line.lineItemCode) : null;
    setCategory(item?.category || '');
    setSubcategory(item?.subcategory || '');
    setIsEditing(false);
  }

  // -------------------------------------------------------------------
  // Outside-click save: when the user clicks outside the row (or pending
  // Combobox panel), save. Clicking within the row's chrome — cell padding,
  // borders, empty space between inputs — is NOT treated as "outside",
  // so accidental clicks won't commit a half-finished row.
  //
  // Why mousedown instead of focusout: focusout fires when an input loses
  // focus to body (i.e., the user clicked on the row's padding), and that
  // was misfiring as "user left the row."
  // -------------------------------------------------------------------
  useEffect(() => {
    if (!isEditing) return;
    // The mobile modal is a fixed overlay rendered OUTSIDE rowRef's DOM subtree
    // and has its own explicit Cancel / Save buttons. The outside-click-to-save
    // and Enter/Escape handling below are desktop-inline-row affordances; on
    // mobile they would misfire (every tap on the modal looks like an "outside"
    // click and would dismiss the editor). So skip them entirely on mobile.
    if (mobile) return;
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Clicked inside the row itself? Ignore — user is still editing.
      if (rowRef.current && rowRef.current.contains(target)) return;
      // Clicked inside the floating Combobox panel? That panel renders outside
      // the row's DOM tree visually (position:fixed) — check for the panel marker.
      if (target.closest('[data-combobox-panel="true"]')) return;
      // Genuine outside click — commit.
      trySave();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      } else if (e.key === 'Enter') {
        const t = e.target as HTMLElement;
        // Don't intercept Enter inside the Combobox (it means "select highlighted item").
        if (t.closest('[role="combobox"]')) return;
        // For inputs and selects: blur the field. The mousedown listener will
        // then save on the NEXT click outside the row. So Enter doesn't commit
        // immediately — it just lets the user move on. This avoids the trap of
        // accidentally saving a half-finished row by hitting Enter early.
        if (t instanceof HTMLElement && 'blur' in t) {
          (t as HTMLElement & { blur: () => void }).blur();
        }
      }
    }
    // Listen for a global "commit-all" signal — fired right before Save & Close
    // or Submit so any open edit rows commit their in-flight changes before
    // the autosave flushes to HubSpot. Without this, the user can click
    // "Save & Close" mid-edit and lose what they just typed.
    function handleCommitAll() {
      trySave();
    }
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('ratecard:commit-all', handleCommitAll as EventListener);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('ratecard:commit-all', handleCommitAll as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, mobile, isComplete, selectedItem, quantityNum, tenantPct, vendor, customVendorCost, lineItemCode, category, subcategory]);

  // -------------------------------------------------------------------
  // Render — VIEW mode
  // -------------------------------------------------------------------
  if (!isEditing) {
    if (!line || !selectedItem) {
      // Defensive: a saved row should always have a line+catalog match. If catalog
      // hasn't loaded yet, show a placeholder.
      return (
        <tr className="border-b border-gray-100 bg-yellow-50">
          <td colSpan={11} className="px-3 py-2 text-sm text-yellow-800">
            Catalog item not loaded yet for {line?.lineItemCode || '(unknown)'}.
          </td>
        </tr>
      );
    }
    return (
      <ViewRow
        line={line}
        item={selectedItem}
        calc={calc}
        readOnly={readOnly}
        mobile={mobile}
        onEnterEdit={() => !readOnly && setIsEditing(true)}
        onDelete={onDelete}
        onOpenPhoto={props.onOpenPhoto}
        onSaveDescription={(text) => {
          // Persist the description change by re-saving the whole line with the
          // new customLaborFullDescription. Other fields stay untouched.
          // Empty string clears the override (falls back to catalog description).
          onSave({
            ...line,
            customLaborFullDescription: text.length > 0 ? text : undefined,
          });
        }}
      />
    );
  }

  // -------------------------------------------------------------------
  // Render — EDIT mode
  // -------------------------------------------------------------------

  // Combobox options for the line item picker
  const lineItemOptions = filteredLineItems.map((item) => ({
    value: item.lineItemCode,
    label: item.laborShortDescription,
    sublabel: catalogDescription(item),
  }));

  // -------------------------------------------------------------------
  // Render — EDIT mode, MOBILE (full-screen stacked card)
  // -------------------------------------------------------------------
  if (mobile) {
    return (
      <tr>
        <td colSpan={12} className="p-0">
          <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center sm:justify-center">
            <div data-modal-scroll className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto shadow-xl">
              {/* Sticky header with title + close */}
              <div className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between z-10">
                <span className="font-heading font-bold text-base text-ink">
                  {line ? 'Edit Line Item' : 'Add Line Item'}
                </span>
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="text-gray-400 hover:text-gray-700 text-2xl leading-none w-8 h-8 flex items-center justify-center"
                  aria-label="Cancel"
                >×</button>
              </div>

              <div className="px-4 py-4 space-y-4">
                <div>
                  <label className="block text-xs font-heading font-bold text-gray-700 mb-1">Category</label>
                  <select
                    value={category}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                    className="h-11 w-full border border-gray-300 rounded-lg px-3 text-base bg-white"
                  >
                    <option value="">Select category…</option>
                    {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-heading font-bold text-gray-700 mb-1">Sub-category</label>
                  <select
                    value={subcategory}
                    onChange={(e) => handleSubcategoryChange(e.target.value)}
                    className="h-11 w-full border border-gray-300 rounded-lg px-3 text-base bg-white"
                  >
                    <option value="">Select sub-category…</option>
                    {subcategories.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-heading font-bold text-gray-700 mb-1">Line Item</label>
                  <Combobox
                    options={lineItemOptions}
                    value={lineItemCode}
                    onChange={handleLineItemChange}
                    placeholder="Type to search items…"
                    emptyLabel={category ? 'No items in this category' : 'No matching items'}
                    scrollIntoViewOnFocus
                  />
                  {selectedItem && (
                    <textarea
                      value={customDescription}
                      onChange={(e) => { descTouchedRef.current = true; setCustomDescription(e.target.value); }}
                      rows={2}
                      className="w-full mt-2 text-sm border border-gray-300 rounded-lg px-3 py-2 text-gray-700 bg-white"
                      placeholder={catalogDescription(selectedItem) || 'Edit description (optional)…'}
                    />
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-heading font-bold text-gray-700 mb-1">
                      Quantity <span className="text-brand">*</span>
                    </label>
                    <input
                      type="number" step="0.01" min="0" inputMode="decimal"
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      className="no-spinner h-11 w-full border border-gray-300 rounded-lg px-3 text-base bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-heading font-bold text-gray-700 mb-1">Unit</label>
                    <div className="h-11 flex items-center px-3 border border-gray-200 rounded-lg bg-gray-50 text-base text-gray-700">
                      {selectedItem?.laborMeas || '—'}
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-heading font-bold text-gray-700 mb-1">
                    Vendor <span className="text-brand">*</span>
                  </label>
                  <select
                    value={vendor}
                    onChange={(e) => setVendor(e.target.value)}
                    className="h-11 w-full border border-gray-300 rounded-lg px-3 text-base bg-white"
                  >
                    {VENDORS.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-heading font-bold text-gray-700 mb-1">
                    Tenant % <span className="text-brand">*</span>
                  </label>
                  <select
                    value={String(tenantPct)}
                    onChange={(e) => { tenantTouchedRef.current = true; setTenantPct(Number(e.target.value)); }}
                    className="h-11 w-full border border-gray-300 rounded-lg px-3 text-base bg-white"
                  >
                    {TENANT_PCT_OPTIONS.map((p) => <option key={p} value={String(p)}>{p}%</option>)}
                  </select>
                </div>

                {/* Totals row: Vendor $ (editable, with pencil) · Client $ · Tenant $.
                    Vendor $ is blank to use the formula; type to override. */}
                <div className="grid grid-cols-3 gap-3 bg-gray-50 rounded-lg p-3 text-center">
                  <div className="flex flex-col items-center">
                    <div className="text-xs font-bold text-gray-700 flex items-center justify-center gap-1 mb-1">
                      Vendor $
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400" aria-hidden>
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </div>
                    <div className="inline-flex items-baseline justify-center">
                      <span className="text-base font-semibold text-gray-800">$</span>
                      <input
                        type="number" step="0.01" min="0" inputMode="decimal"
                        value={customVendorCost}
                        onChange={(e) => setCustomVendorCost(e.target.value)}
                        placeholder={calc && !calc.isCustomPriced ? formatMoney(roundMoney(calc.vendorCost)) : '0.00'}
                        className="no-spinner bg-transparent border-0 focus:ring-0 p-0 text-base font-semibold text-gray-800 text-center w-16"
                        title="Leave blank to use the formula; type a number to override"
                        aria-label="Vendor dollar amount (editable)"
                      />
                    </div>
                  </div>
                  <div className="flex flex-col items-center">
                    <div className="text-xs font-bold text-gray-700 mb-1">Client $</div>
                    <div className="text-base font-semibold text-gray-800">{calc ? `$${formatMoney(roundMoney(calc.clientCost))}` : '—'}</div>
                  </div>
                  <div className="flex flex-col items-center">
                    <div className="text-xs font-bold text-gray-700 mb-1">Tenant $</div>
                    <div className="text-base font-semibold text-brand">{calc ? `$${formatMoney(roundMoney(calc.tenantCost))}` : '—'}</div>
                  </div>
                </div>
              </div>

              {/* Sticky footer action */}
              <div className="sticky bottom-0 bg-white border-t border-gray-200 px-4 py-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="flex-1 h-11 rounded-lg border border-gray-300 text-gray-700 font-heading font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => trySave()}
                  disabled={!isComplete}
                  className={`flex-1 h-11 rounded-lg font-heading font-bold text-white flex items-center justify-center gap-2 ${
                    isComplete ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-gray-300 cursor-not-allowed'
                  }`}
                >
                  <span aria-hidden>✓</span> Save Line
                </button>
              </div>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <>
    <tr ref={rowRef} className="border-b border-brand/30 bg-brand/5">
      {/* Cat */}
      <td className="px-2 py-1.5 align-middle min-w-[110px]">
        <select
          value={category}
          onChange={(e) => handleCategoryChange(e.target.value)}
          className="h-9 w-full border border-gray-300 rounded px-2 text-sm bg-white"
          autoFocus
        >
          <option value="">—</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </td>
      {/* Sub */}
      <td className="px-2 py-1.5 align-middle min-w-[120px]">
        <select
          value={subcategory}
          onChange={(e) => handleSubcategoryChange(e.target.value)}
          className="h-9 w-full border border-gray-300 rounded px-2 text-sm bg-white"
        >
          <option value="">—</option>
          {subcategories.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </td>
      {/* Line Item (combobox, compact variant) — with optional description textarea below.
          max-w caps how wide the description textarea can grow; without it, a
          long auto-filled description can stretch the cell beyond min-w and
          push downstream columns (including the ✓ save button) off-screen. */}
      <td className="px-2 py-1.5 align-middle min-w-[200px] max-w-[280px]">
        <Combobox
          compact
          options={lineItemOptions}
          value={lineItemCode}
          onChange={handleLineItemChange}
          placeholder="Type to search items..."
          emptyLabel={category ? 'No items in this category' : 'No matching items'}
        />
        {selectedItem && (
          <textarea
            value={customDescription}
            onChange={(e) => { descTouchedRef.current = true; setCustomDescription(e.target.value); }}
            rows={2}
            className="w-full mt-1.5 text-xs border border-gray-300 rounded px-2 py-1 text-gray-700 bg-white"
            placeholder={catalogDescription(selectedItem) || 'Edit description (optional)...'}
            title="Edit the full labor description for this line"
          />
        )}
      </td>
      {/* Qty (center-aligned, no spinner) */}
      <td className="px-2 py-1.5 text-center align-middle">
        <input
          type="number"
          step="0.01"
          min="0"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          className="no-spinner h-9 w-14 border border-gray-300 rounded px-1 text-sm text-center bg-white mx-auto"
        />
      </td>
      {/* Unit (read-only — auto from line item) */}
      <td className="px-2 py-1.5 text-center text-sm text-gray-700 align-middle">
        {selectedItem?.laborMeas || '—'}
      </td>
      {/* Vendor */}
      <td className="px-2 py-1.5 align-middle min-w-[100px] max-w-[130px]">
        <select
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          className="h-9 w-full border border-gray-300 rounded px-1 text-xs bg-white"
          title={vendor}
        >
          {VENDORS.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </td>
      {/* Vendor $ — override input */}
      <td className="px-2 py-1.5 align-middle">
        <input
          type="number"
          step="0.01"
          min="0"
          value={customVendorCost}
          onChange={(e) => setCustomVendorCost(e.target.value)}
          placeholder={calc && !calc.isCustomPriced ? formatMoney(roundMoney(calc.vendorCost)) : '0.00'}
          className="no-spinner h-9 w-20 border border-gray-300 rounded px-1 text-sm text-right bg-white"
          title="Leave blank to use formula; type a number to override"
        />
      </td>
      {/* Client $ — computed display */}
      <td className="px-2 py-1.5 text-right text-sm text-gray-700 align-middle whitespace-nowrap">
        {calc ? `$${formatMoney(roundMoney(calc.clientCost))}` : '—'}
      </td>
      {/* Tenant % — native <select> dropdown (matches Category/Sub). A plain
          picker is cleaner on mobile than a typeable combobox: tapping opens
          the OS picker with the fixed 0–100% list, no keyboard. Fixed-width so
          the column doesn't bloat (values are at most 4 chars, "100%"). */}
      <td className="px-2 py-1.5 text-center align-middle">
        <div className="w-[72px] mx-auto">
          <select
            value={String(tenantPct)}
            onChange={(e) => setTenantPct(Number(e.target.value))}
            className="h-9 w-full border border-gray-300 rounded px-1 text-sm bg-white text-center"
          >
            {TENANT_PCT_OPTIONS.map((p) => (
              <option key={p} value={String(p)}>{p}%</option>
            ))}
          </select>
        </div>
      </td>
      {/* Tenant $ — computed display */}
      <td className="px-2 py-1.5 text-right text-sm font-semibold text-brand align-middle whitespace-nowrap">
        {calc ? `$${formatMoney(roundMoney(calc.tenantCost))}` : '—'}
      </td>
      {/* Actions: ✓ save (explicit confirm) + × cancel.
          Save is also still triggered by clicking outside the row, so this
          button is more of a touch-friendly affordance than a strict
          requirement. Disabled until all required fields are filled. */}
      <td className="px-2 py-1 align-middle">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}  // don't blur the row
            onClick={(e) => { e.stopPropagation(); trySave(); }}
            disabled={!isComplete}
            className={`h-9 w-9 rounded flex items-center justify-center text-base leading-none ${
              isComplete
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
            title={isComplete ? 'Save line (Enter)' : 'Fill in Category, Line Item, Qty, and Vendor first'}
            aria-label="Save line"
          >
            ✓
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}  // don't blur the row
            onClick={(e) => { e.stopPropagation(); cancelEdit(); }}
            className="h-9 w-9 rounded flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 text-lg leading-none"
            title="Cancel (Esc)"
            aria-label="Cancel edit"
          >
            ×
          </button>
        </div>
      </td>
    </tr>
    {/* Math debug panel — shown only in edit mode for sanity-checking the
        vendor $ formula. Hidden by default; flip SHOW_MATH_DEBUG to true to
        bring it back without re-importing. The <MathDebugRow> component is
        intentionally left in this file so re-enabling is a one-line change. */}
    {SHOW_MATH_DEBUG && selectedItem && calc && (
      <MathDebugRow
        item={selectedItem}
        calc={calc}
        quantity={quantityNum}
        tenantPct={tenantPct}
        customLaborRate={line?.customLaborRate ?? null}
        customAdjustedMaterialCost={line?.customAdjustedMaterialCost ?? null}
        customVendorCost={customVendorCost.trim() === '' ? null : Number(customVendorCost)}
      />
    )}
    </>
  );
}

// ---------------------------------------------------------------------------
// View row — read-only saved line
// ---------------------------------------------------------------------------

interface ViewRowProps {
  line: RateCardLineInput;
  item: RateCardLineItem;
  calc: ReturnType<typeof calculateLine> | null;
  readOnly?: boolean;
  mobile?: boolean;
  onEnterEdit: () => void;
  onDelete: () => void;
  onOpenPhoto?: (index: number) => void;
  onSaveDescription: (text: string) => void;
}

function ViewRow({ line, item, calc, readOnly, mobile, onEnterEdit, onDelete, onOpenPhoto, onSaveDescription }: ViewRowProps) {
  const [showFull, setShowFull] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const descTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const fullDescription = line.customLaborFullDescription || catalogDescription(item);
  const shortDescription = item.laborShortDescription;
  const truncated = fullDescription.length > 120
    ? fullDescription.slice(0, 120).trim() + '…'
    : fullDescription;
  const isTruncated = fullDescription.length > 120;
  const pill = vendorPillStyle(line.assignedTo);

  function startEditDesc(e: React.MouseEvent) {
    e.stopPropagation();
    setDescDraft(fullDescription);
    setEditingDesc(true);
    // Focus + auto-size the textarea on next tick
    setTimeout(() => {
      descTextareaRef.current?.focus();
      descTextareaRef.current?.select();
    }, 0);
  }

  function commitDesc() {
    const next = descDraft.trim();
    // Only persist if it actually changed from what's saved
    if (next !== (line.customLaborFullDescription || catalogDescription(item))) {
      onSaveDescription(next);
    }
    setEditingDesc(false);
  }

  function cancelDesc() {
    setEditingDesc(false);
    setDescDraft('');
  }

  // -------------------------------------------------------------------
  // MOBILE: compact card (no horizontal scroll). Details stacked on the
  // left, Vendor/Client/Tenant $ as right-aligned mini-columns. Tapping the
  // card enters edit mode (same as the desktop row). Rendered inside a
  // full-width <td> so the surrounding <table> stays valid.
  // -------------------------------------------------------------------
  if (mobile) {
    const money2 = (n: number) => `$${formatMoney(roundMoney(n))}`;
    const subParts = [item.category, item.subcategory].filter(Boolean).join(' · ');
    const qtyUnit = `${line.quantity} ${item.laborMeas}`.trim();
    return (
      <tr data-line-id={line.externalId}>
        <td colSpan={12} className="p-0">
          <div
            onClick={readOnly || editingDesc ? undefined : onEnterEdit}
            className={`relative flex gap-2 border border-gray-200 rounded-lg pl-3 py-2.5 mb-2 bg-white ${readOnly ? 'pr-3' : 'pr-8'} ${readOnly || editingDesc ? '' : 'active:bg-gray-50 cursor-pointer'}`}
          >
            {/* Quick-delete X — top-right corner of the card. Low z-index so it
                scrolls UNDER the sticky totals header instead of floating over
                it. Deletes immediately, no confirm. */}
            {!readOnly && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                aria-label="Delete line item"
                className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center rounded-full bg-white border border-gray-300 text-gray-400 hover:text-red-600 hover:border-red-300 shadow-sm text-base leading-none z-0"
              >
                ×
              </button>
            )}
            {/* Left: description + details (flexes, but never pushes the price
                block — that block has a fixed width so columns always align) */}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-ink leading-snug">{shortDescription}</div>
              {/* Subtext: clamp to 2 lines, then a "more" toggle. */}
              {fullDescription && fullDescription !== shortDescription && (
                <div className="text-xs text-gray-500 mt-0.5 leading-snug">
                  <span className={showFull ? '' : 'line-clamp-2'}>{fullDescription}</span>
                  {isTruncated && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowFull((v) => !v); }}
                      className="text-brand underline"
                    >
                      {showFull ? 'less' : 'more'}
                    </button>
                  )}
                </div>
              )}
              <div className="text-xs text-gray-500 mt-0.5">{subParts}{subParts ? ' · ' : ''}{qtyUnit}</div>
              <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                {/* Vendor-only chip */}
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold max-w-full truncate ${pill.bg} ${pill.text} ${pill.border || ''}`}
                  title={line.assignedTo}
                >
                  {line.assignedTo}
                </span>
                {line.note && <span className="text-[11px] italic text-gray-600 truncate">📝 {line.note}</span>}
                {calc?.isCustomPriced && <span className="text-[11px] font-semibold text-yellow-700">⚡ Custom</span>}
              </div>
              {(line.photoUrls?.length ?? 0) > 0 && (
                <div className="mt-1.5 flex gap-1 flex-wrap">
                  {line.photoUrls.map((u, i) => (
                    <span key={`${u}-${i}`} className="relative inline-block">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={displayImageSrc(u)}
                        alt=""
                        onClick={(e) => { e.stopPropagation(); onOpenPhoto?.(i); }}
                        className="w-10 h-10 object-cover rounded border border-gray-200 cursor-pointer"
                        title={isVideoEntry(u) ? 'Tap to play' : 'Tap to view / mark up'}
                      />
                      {isVideoEntry(u) && (
                        <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <span className="w-4 h-4 rounded-full bg-black/55 flex items-center justify-center">
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
                          </span>
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {/* Right: fixed-width Vendor / Client / Tenant columns. Each column is
                a fixed width and right-aligned so values line up across cards
                regardless of amount length or left-side subtext. */}
            <div className="flex border-l border-gray-100 pl-2 shrink-0">
              <div className="w-[60px] text-right">
                <div className="text-[10px] uppercase tracking-wide text-gray-400">Vendor</div>
                <div className="text-[12px] text-gray-900 mt-0.5 tabular-nums whitespace-nowrap">{calc ? money2(calc.vendorCost) : '…'}</div>
              </div>
              <div className="w-[60px] text-right">
                <div className="text-[10px] uppercase tracking-wide text-gray-400">Client</div>
                <div className="text-[12px] text-gray-900 mt-0.5 tabular-nums whitespace-nowrap">{calc ? money2(calc.clientCost) : '…'}</div>
              </div>
              <div className="w-[60px] text-right">
                <div className="text-[10px] uppercase tracking-wide text-gray-400">Tenant</div>
                <div className="text-[12px] font-semibold text-brand mt-0.5 tabular-nums whitespace-nowrap">{calc ? money2(calc.tenantCost) : '…'}</div>
                {/* Tenant % in parens under the tenant $ — same pink as the $ */}
                <div className="text-[10px] text-brand tabular-nums">({line.tenantBillBackPercent}%)</div>
              </div>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr
      data-line-id={line.externalId}
      onClick={readOnly || editingDesc ? undefined : onEnterEdit}
      className={`border-b border-gray-100 ${readOnly || editingDesc ? '' : 'hover:bg-gray-50 cursor-pointer'}`}
    >
      <td className="px-3 py-2 text-center text-sm text-gray-700 whitespace-nowrap">{item.category}</td>
      <td className="px-3 py-2 text-center text-sm text-gray-700 whitespace-nowrap">{item.subcategory}</td>
      <td className="px-3 py-2 min-w-[260px]">
        <div className="font-medium text-sm text-ink">{shortDescription}</div>
        {editingDesc ? (
          <div onClick={(e) => e.stopPropagation()}>
            <textarea
              ref={descTextareaRef}
              value={descDraft}
              onChange={(e) => setDescDraft(e.target.value)}
              onBlur={commitDesc}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); cancelDesc(); }
                // Plain Enter inserts newline (textareas); ctrl/cmd-Enter commits
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  commitDesc();
                }
              }}
              rows={3}
              className="w-full text-xs border border-brand rounded px-2 py-1 mt-1 text-gray-700"
              placeholder="Edit the labor description for this line..."
            />
            <div className="text-xs text-gray-400 mt-0.5">
              Click outside or press Cmd/Ctrl+Enter to save · Esc to cancel
            </div>
          </div>
        ) : (
          <div className="text-xs text-gray-500">
            {showFull ? fullDescription : truncated}
            {isTruncated && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowFull((v) => !v); }}
                className="ml-2 text-brand underline"
              >
                {showFull ? 'less' : 'more'}
              </button>
            )}
            {!readOnly && (
              <button
                type="button"
                onClick={startEditDesc}
                className="ml-1.5 inline-flex align-baseline text-gray-400 hover:text-brand"
                title="Edit description"
                aria-label="Edit labor description"
              >
                {/* Smaller inline SVG pencil — sized to match the small description text */}
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 1.5l3.5 3.5L5 14.5H1.5V11L11 1.5z" />
                </svg>
              </button>
            )}
          </div>
        )}
        {line.note && <div className="text-xs italic text-gray-600 mt-1">📝 {line.note}</div>}
        {calc?.isCustomPriced && <div className="text-xs font-semibold text-yellow-700 mt-1">⚡ Custom Priced</div>}
        {(line.photoUrls?.length ?? 0) > 0 && (
          <div className="mt-1.5 flex gap-1 flex-wrap">
            {line.photoUrls.map((u, i) => (
              <span key={`${u}-${i}`} className="relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={displayImageSrc(u)}
                  alt=""
                  onClick={(e) => { e.stopPropagation(); onOpenPhoto?.(i); }}
                  className="w-10 h-10 object-cover rounded border border-gray-200 cursor-pointer"
                  title={isVideoEntry(u) ? 'Click to play' : 'Click to view / mark up'}
                />
                {isVideoEntry(u) && (
                  <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <span className="w-4 h-4 rounded-full bg-black/55 flex items-center justify-center">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
                    </span>
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-center text-sm text-gray-900 whitespace-nowrap">{line.quantity}</td>
      <td className="px-3 py-2 text-center text-sm text-gray-700 whitespace-nowrap">{item.laborMeas}</td>
      <td className="px-3 py-2 text-center whitespace-nowrap">
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold max-w-[140px] truncate ${pill.bg} ${pill.text} ${pill.border || ''}`}
          title={line.assignedTo}
        >
          {line.assignedTo}
        </span>
      </td>
      <td className="px-3 py-2 text-right text-sm text-gray-900 whitespace-nowrap">
        {calc ? `$${formatMoney(roundMoney(calc.vendorCost))}` : '…'}
      </td>
      <td className="px-3 py-2 text-right text-sm text-gray-900 whitespace-nowrap">
        {calc ? `$${formatMoney(roundMoney(calc.clientCost))}` : '…'}
      </td>
      <td className="px-3 py-2 text-center text-sm text-gray-700 whitespace-nowrap">{line.tenantBillBackPercent}%</td>
      <td className="px-3 py-2 text-right text-sm font-semibold text-brand whitespace-nowrap">
        {calc ? `$${formatMoney(roundMoney(calc.tenantCost))}` : '…'}
      </td>
      <td className="px-2 py-2 whitespace-nowrap">
        <div className="flex items-center gap-1">
          {!readOnly && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="text-red-500 hover:text-red-700 text-lg leading-none px-2"
              aria-label="Delete line"
              title="Delete this line"
            >
              ×
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// MathDebugRow — TEMPORARY validation panel. Renders a wide row below the
// edit row showing every input to the formula and the formula with values
// plugged in. Helps sanity-check the math.
//
// DELETE THIS COMPONENT and its <MathDebugRow> render call once the math is
// confirmed correct.
// ---------------------------------------------------------------------------

interface MathDebugRowProps {
  item: RateCardLineItem;
  calc: NonNullable<ReturnType<typeof calculateLine>>;
  quantity: number;
  tenantPct: number;
  customLaborRate: number | null;
  customAdjustedMaterialCost: number | null;
  customVendorCost: number | null;
}

function MathDebugRow(p: MathDebugRowProps) {
  const { item, calc } = p;
  // Recompute the intermediates so we can show them. These mirror what
  // calculateLine() does internally.
  const adjustedMaterialCost = p.customAdjustedMaterialCost != null
    ? p.customAdjustedMaterialCost
    : calc.materialCostSnapshot * calc.materialCostAdjustmentSnapshot * (1 + calc.materialTaxAdjustmentSnapshot);
  const materialUnits = Math.max(1, calc.materialQtySnapshot * p.quantity);
  const computedVendorCost = calc.laborTotal + calc.materialTotal;

  const fmt = (v: number, d = 2) => v.toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

  // Compact formatter for inputs (no padding zeros for whole numbers)
  const fmtRaw = (v: number) => Number.isInteger(v) ? String(v) : fmt(v, 4);

  return (
    <tr className="bg-yellow-50/70 border-b-2 border-yellow-200">
      <td colSpan={11} className="px-4 py-3">
        <div className="text-[11px] font-mono text-gray-800">
          <div className="font-bold text-yellow-900 mb-1.5 flex items-center justify-between">
            <span>🧮 Math Debug — Temporary</span>
            <span className="text-[10px] text-gray-500 font-normal">remove once validated</span>
          </div>
          <div className="grid grid-cols-3 gap-4">
            {/* Column 1: catalog inputs */}
            <div>
              <div className="font-bold text-gray-600 uppercase mb-1">Catalog Item</div>
              <table className="w-full"><tbody>
                <tr><td className="text-gray-600 pr-2">code</td><td>{item.lineItemCode}</td></tr>
                <tr><td className="text-gray-600 pr-2">category</td><td>{item.category}</td></tr>
                <tr><td className="text-gray-600 pr-2">labor_hours</td><td>{fmtRaw(item.laborHours)}</td></tr>
                <tr><td className="text-gray-600 pr-2">material_rate</td><td>{fmtRaw(item.materialRate)}</td></tr>
                <tr><td className="text-gray-600 pr-2">material_qty</td><td>{fmtRaw(item.materialQty)}</td></tr>
                <tr><td className="text-gray-600 pr-2">material_cost</td><td>{fmt(item.materialCost)}</td></tr>
                <tr><td className="text-gray-600 pr-2">is_labor_only</td><td>{String(item.isLaborOnly)}</td></tr>
                <tr><td className="text-gray-600 pr-2">is_bid_item</td><td>{String(item.isBidItem)}</td></tr>
              </tbody></table>
            </div>

            {/* Column 2: region + inspector inputs */}
            <div>
              <div className="font-bold text-gray-600 uppercase mb-1">Region — {calc.regionSnapshot}</div>
              <table className="w-full"><tbody>
                <tr>
                  <td className="text-gray-600 pr-2">labor_rate (for {item.category})</td>
                  <td>
                    {fmt(calc.laborHourlyRateSnapshot)}
                    {p.customLaborRate != null && (
                      <span className="text-violet-600 ml-1">[override]</span>
                    )}
                  </td>
                </tr>
                <tr><td className="text-gray-600 pr-2">material_cost_adjustment</td><td>{fmtRaw(calc.materialCostAdjustmentSnapshot)}</td></tr>
                <tr><td className="text-gray-600 pr-2">material_tax_adjustment</td><td>{fmtRaw(calc.materialTaxAdjustmentSnapshot)}</td></tr>
              </tbody></table>
              <div className="font-bold text-gray-600 uppercase mb-1 mt-2">Inspector Inputs</div>
              <table className="w-full"><tbody>
                <tr><td className="text-gray-600 pr-2">quantity</td><td>{fmtRaw(p.quantity)}</td></tr>
                <tr><td className="text-gray-600 pr-2">tenant_bill_back_%</td><td>{p.tenantPct}%</td></tr>
                <tr>
                  <td className="text-gray-600 pr-2">custom_vendor_cost</td>
                  <td className={p.customVendorCost != null ? 'text-violet-600 font-semibold' : 'text-gray-400'}>
                    {p.customVendorCost != null ? fmt(p.customVendorCost) : '(none)'}
                  </td>
                </tr>
                <tr>
                  <td className="text-gray-600 pr-2">custom_labor_rate</td>
                  <td className={p.customLaborRate != null ? 'text-violet-600 font-semibold' : 'text-gray-400'}>
                    {p.customLaborRate != null ? fmt(p.customLaborRate) : '(none)'}
                  </td>
                </tr>
                <tr>
                  <td className="text-gray-600 pr-2">custom_adj_mat_cost</td>
                  <td className={p.customAdjustedMaterialCost != null ? 'text-violet-600 font-semibold' : 'text-gray-400'}>
                    {p.customAdjustedMaterialCost != null ? fmt(p.customAdjustedMaterialCost) : '(none)'}
                  </td>
                </tr>
              </tbody></table>
            </div>

            {/* Column 3: formula with values */}
            <div>
              <div className="font-bold text-gray-600 uppercase mb-1">Formula</div>
              <table className="w-full"><tbody>
                <tr>
                  <td className="text-gray-600 pr-2">labor_total</td>
                  <td className="whitespace-nowrap">
                    = {fmtRaw(item.laborHours)} × {fmt(calc.laborHourlyRateSnapshot)} × {fmtRaw(p.quantity)}
                  </td>
                </tr>
                <tr>
                  <td></td>
                  <td className="font-semibold">= ${fmt(calc.laborTotal)}</td>
                </tr>
                {!item.isLaborOnly && (
                  <>
                    <tr><td colSpan={2} className="pt-1.5"></td></tr>
                    <tr>
                      <td className="text-gray-600 pr-2">adj_mat_cost</td>
                      <td className="whitespace-nowrap">
                        {p.customAdjustedMaterialCost != null
                          ? <>= {fmt(p.customAdjustedMaterialCost)} <span className="text-violet-600">[override]</span></>
                          : <>= {fmt(item.materialCost)} × {fmtRaw(calc.materialCostAdjustmentSnapshot)} × (1 + {fmtRaw(calc.materialTaxAdjustmentSnapshot)})</>
                        }
                      </td>
                    </tr>
                    <tr>
                      <td></td>
                      <td className="font-semibold">= ${fmt(adjustedMaterialCost)}</td>
                    </tr>
                    <tr>
                      <td className="text-gray-600 pr-2">material_units</td>
                      <td className="whitespace-nowrap">
                        = MAX(1, {fmtRaw(item.materialQty)} × {fmtRaw(p.quantity)}) = {fmtRaw(materialUnits)}
                      </td>
                    </tr>
                    <tr>
                      <td className="text-gray-600 pr-2">material_total</td>
                      <td className="whitespace-nowrap">
                        = {fmtRaw(item.materialRate)} × {fmtRaw(materialUnits)} × {fmt(adjustedMaterialCost)}
                      </td>
                    </tr>
                    <tr>
                      <td></td>
                      <td className="font-semibold">= ${fmt(calc.materialTotal)}</td>
                    </tr>
                  </>
                )}
                {item.isLaborOnly && (
                  <tr>
                    <td className="text-gray-600 pr-2">material_total</td>
                    <td className="font-semibold">= $0.00 <span className="text-gray-400">(labor only)</span></td>
                  </tr>
                )}
                <tr><td colSpan={2} className="pt-1.5"></td></tr>
                <tr>
                  <td className="text-gray-600 pr-2">vendor_cost</td>
                  <td className="whitespace-nowrap">
                    {p.customVendorCost != null
                      ? <>= {fmt(p.customVendorCost)} <span className="text-violet-600">[override]</span></>
                      : <>= ${fmt(calc.laborTotal)} + ${fmt(calc.materialTotal)} = ${fmt(computedVendorCost)}</>
                    }
                  </td>
                </tr>
                <tr>
                  <td></td>
                  <td className="font-semibold text-base">= ${fmt(calc.vendorCost)}</td>
                </tr>
                <tr>
                  <td className="text-gray-600 pr-2">client_cost</td>
                  <td className="whitespace-nowrap">
                    = ${fmt(calc.vendorCost)} × 1.20 = <span className="font-semibold">${fmt(calc.clientCost)}</span>
                  </td>
                </tr>
                <tr>
                  <td className="text-gray-600 pr-2">tenant_cost</td>
                  <td className="whitespace-nowrap">
                    = ${fmt(calc.clientCost)} × {(p.tenantPct / 100).toFixed(2)} = <span className="font-semibold text-brand">${fmt(calc.tenantCost)}</span>
                  </td>
                </tr>
              </tbody></table>
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}
