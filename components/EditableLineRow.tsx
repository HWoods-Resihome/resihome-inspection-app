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
import { depKindForCategory, depreciationTenantPct, tenantPctCapStatus } from '@/lib/depreciation';
import { Combobox } from '@/components/Combobox';
import { WheelPicker } from '@/components/WheelPicker';
import { ListPicker } from '@/components/ListPicker';
import { calculateLine, roundMoney } from '@/lib/rateCardMath';
import { formatMoney, formatQty } from '@/lib/photoUpload';
import { displayImageSrc } from '@/lib/photoDisplay';
import { isVideoEntry } from '@/lib/media';
import { VENDORS, vendorPillStyle, isInternalResolution, defaultVendorForCode } from '@/lib/vendors';
import { setNativeKeyboardAccessoryBarVisible } from '@/lib/nativeBridge';
import { NumberField } from '@/components/NumberPad';
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
  // O(1) code→item lookup over the same catalog. Optional: when the parent
  // already has one (the rate-card form), pass it so each row doesn't linear-scan
  // the whole catalog on every render; otherwise the row derives one from `catalog`.
  catalogByCode?: Map<string, RateCardLineItem>;
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
  // Whether the Internal Resolution "After Photos" feature is active (the
  // after_photo_urls property exists in HubSpot). When false the panel is hidden
  // so nothing tries to save after-photos before the migration has run.
  afterPhotosEnabled?: boolean;
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
  // Open the in-app camera to capture AFTER photos for this (Internal
  // Resolution) line. Owned by the parent so it uses the established
  // CameraCapture, not the OS picker. Captured URLs are appended + saved there.
  onCaptureAfterPhotos?: () => void;
  // Open the line's AFTER photo at `index` in the lightbox (view/delete/replace).
  onOpenAfterPhoto?: (index: number) => void;
  // Internal Resolution completion timing: "now" enforces after-photos at
  // finalize; "later" defers them. Persisted by the parent.
  resolutionTiming?: 'now' | 'later';
  onSetResolutionTiming?: (lineExternalId: string, v: 'now' | 'later') => void;
  // Reports when this row's edit modal opens/closes (so the parent can hide the
  // floating mic while a line modal is up).
  onEditingChange?: (editing: boolean) => void;
}

// Borderless, filled field styling for the mobile editor (no heavy border — a
// light grey fill reads cleaner). Shared by the pop-up triggers and plain inputs.
const TRIGGER_CLS = 'h-11 w-full bg-gray-100 rounded-lg px-3 text-base text-ink flex items-center justify-between disabled:opacity-60';
const INPUT_CLS = 'h-11 w-full bg-gray-100 rounded-lg px-3 text-base text-ink outline-none focus:ring-2 focus:ring-brand/20';

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

/** Format "{qty} {friendly unit}" for the line-title parenthetical, e.g.
 *  3 EA -> "3 ea", 1448 SF -> "1,448 sq ft". Returns '' if qty is invalid. */
function friendlyQtyUnit(qty: number, meas: string): string {
  if (!isFinite(qty) || qty <= 0) return '';
  const n = qty.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const u = (meas || '').trim().toUpperCase();
  const friendly = u === 'SF' ? 'sq ft' : u === 'LF' ? 'lin ft' : u === 'SY' ? 'sq yd'
    : u === 'EA' ? 'ea' : u === 'HR' ? 'hr' : (meas || '').trim().toLowerCase();
  return friendly ? `${n} ${friendly}` : n;
}

/**
 * Amber warning triangle shown next to a tenant % that has been manually raised
 * ABOVE the paint/flooring depreciation cap for the tenant's time in home.
 * Renders nothing for non-cap-eligible lines or when the % is at/below the cap.
 *
 * Tappable on mobile + desktop: clicking flashes a short message that auto-
 * dismisses after a moment (mobile has no hover, so a tap is the affordance).
 */
function OverCapAlert({
  category, description, tenantPct, months, className,
}: {
  category: string | undefined | null;
  description: string | undefined | null;
  tenantPct: number;
  months: number | null | undefined;
  className?: string;
}) {
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const status = tenantPctCapStatus(category, description, tenantPct, months);
  if (!status || !status.over) return null;

  const kindLabel = status.kind.charAt(0).toUpperCase() + status.kind.slice(1);
  const label = `Above ${status.cap}% ${kindLabel} Cap`;

  // Toggle the message: click shows it (and it auto-hides after a moment);
  // click again closes it immediately. stopPropagation keeps the tap on the
  // icon itself — it never opens the line editor / changes the field, so it's
  // usable directly on a saved line without entering the add/edit popup.
  const toggleFlash = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (flashTimer.current) { clearTimeout(flashTimer.current); flashTimer.current = null; }
    setFlash((prev) => {
      const next = !prev;
      if (next) flashTimer.current = setTimeout(() => setFlash(false), 2500);
      return next;
    });
  };

  return (
    <span className={`relative inline-flex ${className || ''}`}>
      <button
        type="button"
        onClick={toggleFlash}
        onMouseDown={(e) => e.preventDefault()}  // don't blur the row mid-edit
        className="inline-flex text-amber-500 hover:text-amber-600"
        title={label}
        aria-label={label}
        aria-expanded={flash}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </button>
      {flash && (
        <span
          role="status"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-0.5 rounded bg-amber-500 text-white text-[10px] font-semibold whitespace-nowrap shadow z-50 pointer-events-none"
        >
          {label}
        </span>
      )}
    </span>
  );
}

/**
 * Read-only-ish "Before / After Photos" block for Internal Resolution lines.
 *
 * The capture itself is owned by the parent (RateCardForm) so it opens the
 * in-app CameraCapture — the established quick-snap camera with the evidence
 * stamp — via onAdd(), NOT the OS file picker. This component just renders the
 * thumbnails, a delete affordance (onChange), and the "+" that triggers onAdd.
 *
 * `required` flags the empty After-Photos state amber. `addLabel`/`emptyLabel`
 * let it double as the "Before Photos" display (no + / required).
 */
function PhotoChipRow({
  urls, label, required, onAdd, onChange, onOpen, readOnly,
}: {
  urls: string[];
  label: string;
  required?: boolean;
  onAdd?: () => void;            // when set, shows the "+" (in-app camera)
  onChange?: (urls: string[]) => void;  // when set, thumbnails get a delete ×
  onOpen?: (index: number) => void;     // when set, tapping a thumbnail opens the lightbox
  readOnly?: boolean;
}) {
  const removeAt = (i: number) => onChange?.((urls || []).filter((_, idx) => idx !== i));
  const showAdd = !readOnly && !!onAdd;
  return (
    <div className="mt-2" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500 whitespace-nowrap shrink-0">{label}</span>
        {urls.length > 0
          ? <span className="text-[10px] text-emerald-600">&#10003; {urls.length}</span>
          : required
            ? <span className="text-[10px] font-semibold text-amber-600">Required</span>
            : <span className="text-[10px] font-semibold text-gray-400">Optional</span>}
      </div>
      <div className="flex gap-1.5 flex-wrap items-center">
        {urls.map((u, i) => (
          <span key={`${u}-${i}`} className="relative inline-block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={displayImageSrc(u)}
              alt=""
              onClick={onOpen ? (e) => { e.stopPropagation(); onOpen(i); } : undefined}
              className={`w-12 h-12 object-cover rounded border border-gray-200 ${onOpen ? 'cursor-pointer' : ''}`}
              title={onOpen ? (isVideoEntry(u) ? 'Tap to play' : 'Tap to view') : undefined}
            />
            {!readOnly && onChange && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); removeAt(i); }}
                aria-label={`Remove ${label.toLowerCase()}`}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center rounded-full bg-white border border-gray-300 text-gray-500 hover:text-red-600 hover:border-red-300 shadow-sm text-xs leading-none"
              >×</button>
            )}
          </span>
        ))}
        {showAdd && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onAdd!(); }}
            className={`w-12 h-12 rounded border-2 border-dashed flex items-center justify-center ${
              required
                ? 'border-amber-300 text-amber-500 hover:border-amber-400 hover:text-amber-600'
                : 'border-gray-300 text-gray-400 hover:border-gray-400 hover:text-gray-500'
            }`}
            title="Take an after photo (in-app camera)"
            aria-label="Add after photo"
          >
            <span className="text-xl leading-none">+</span>
          </button>
        )}
        {!showAdd && urls.length === 0 && (
          <span className="text-[11px] text-gray-400">None tagged</span>
        )}
      </div>
    </div>
  );
}

export function EditableLineRow(props: Props) {
  const {
    line, catalog, catalogByCode: catalogByCodeProp, regions, inspectionRegion,
    section, location, readOnly, startInEditMode, mobile,
    onSave, onDelete, onDiscardNew, autoSfQuantity, tenantMonths, afterPhotosEnabled,
    onCaptureAfterPhotos, onOpenAfterPhoto,
  } = props;

  // Use the parent-supplied code→item Map when present (the rate-card form passes
  // one); otherwise derive it from `catalog` so standalone callers still get O(1)
  // lookups instead of linear scans.
  const byCode = useMemo(
    () => catalogByCodeProp ?? new Map(catalog.map((c) => [c.lineItemCode, c])),
    [catalogByCodeProp, catalog],
  );

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
  // Internal Resolution completion timing (editor copy). Defaults to "Complete
  // Now"; persisted on save via onSetResolutionTiming keyed by the line id.
  const [editTiming, setEditTiming] = useState<'now' | 'later'>(props.resolutionTiming || 'now');
  // Whether a Now/Later choice was already made for this line (a stored timing
  // existed at mount). On DESKTOP, selecting Internal Resolution requires an
  // explicit choice before the line can be saved or the row left — so we track
  // whether one has been made this session. On MOBILE we keep the existing
  // behavior (defaults to "Complete Now", no hard requirement), per the
  // manual-add popup spec.
  const initialHasTiming = props.resolutionTiming === 'now' || props.resolutionTiming === 'later';
  const [timingChosen, setTimingChosen] = useState<boolean>(mobile ? true : initialHasTiming);
  // Set true when the user tries to leave/save an Internal Resolution line on
  // desktop without picking Now/Later — turns the toggle red to nudge them.
  const [timingPrompt, setTimingPrompt] = useState(false);
  const [customVendorCost, setCustomVendorCost] = useState<string>(
    line?.customVendorCost != null ? String(line.customVendorCost) : ''
  );
  // Editable full labor description. Initialized to whatever the line already
  // has (custom override or empty). The placeholder shows the catalog default
  // so the inspector knows what the falsy state will resolve to.
  const [customDescription, setCustomDescription] = useState<string>(
    line?.customLaborFullDescription || ''
  );
  // True while the Line Item search input is focused (keyboard open). Grows the
  // card with bottom white space so the field can scroll up and the dropdown
  // options clear the on-screen keyboard.
  const [searchFocused, setSearchFocused] = useState(false);

  // Initialize category/subcategory from catalog lookup when entering edit mode
  // or on first mount of an existing line.
  useEffect(() => {
    if (!line?.lineItemCode || catalog.length === 0) return;
    const item = byCode.get(line.lineItemCode);
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
    return byCode.get(lineItemCode) || null;
  }, [byCode, lineItemCode]);

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
  // Tracks which line item the current description belongs to. Initialized to
  // the saved line's item so its override survives mount; when the SELECTED
  // ITEM changes (new short labor description, or cleared via a category swap)
  // we reset the subtext to the new item's default — a manual edit only sticks
  // while the same item stays selected.
  const lastDescItemRef = useRef<string | null>(line?.lineItemCode || null);
  // Quantity edit UX: clear the field on focus so the inspector types fresh
  // (no need to delete the existing value); if they leave without entering
  // anything, restore the prior value so it still saves.
  const qtyBeforeFocusRef = useRef('');
  const onQtyFocus = () => {
    qtyBeforeFocusRef.current = quantity;
    setQuantity('');
    // Hide the iOS keyboard accessory toolbar (< > / Done) while typing a number
    // in the native shell — pure number entry doesn't need it. No-op on web/Android.
    setNativeKeyboardAccessoryBarVisible(false);
  };
  const onQtyBlur = () => {
    if (quantity.trim() === '') setQuantity(qtyBeforeFocusRef.current);
    setNativeKeyboardAccessoryBarVisible(true);
  };
  // Bid-item subcategories carry a bespoke scope the inspector writes from
  // scratch, so focusing the description selects-all (typing REPLACES the whole
  // text). Every other item keeps its catalog default and the inspector just
  // APPENDS notes — so focus drops the cursor at the end.
  const isBidItemDesc = !!selectedItem && (selectedItem.isBidItem || /bid\s*item/i.test(selectedItem.subcategory || ''));
  const onDescFocus = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    if (isBidItemDesc) { e.target.select(); return; }
    const len = e.target.value.length;
    e.target.setSelectionRange(len, len);
  };
  useEffect(() => {
    const code = selectedItem?.lineItemCode || '';
    if (code === (lastDescItemRef.current || '')) return; // same item — keep any edit
    // Different item selected (or cleared): always reset the subtext to the new
    // item's default description and forget the prior manual edit.
    lastDescItemRef.current = code || null;
    descTouchedRef.current = false;
    setCustomDescription(selectedItem ? catalogDescription(selectedItem) : '');
    // Per-code default vendor: pre-select the rule's vendor (e.g. eviction codes
    // → Eviction Vendor; flooring FLORL1011 → Vendor 2). Only when the new code
    // has a rule — otherwise leave the current vendor as-is. Still editable.
    const dv = defaultVendorForCode(code);
    if (dv) setVendor(dv);
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
      const item = byCode.get(code);
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

  function handleVendorChange(v: string) {
    setVendor(v);
    if (isInternalResolution(v)) {
      // Switching INTO Internal Resolution on desktop forces a fresh Now/Later
      // decision unless one was already stored for this line.
      if (!mobile && !initialHasTiming) setTimingChosen(false);
    } else {
      // Not Internal Resolution → no timing requirement; clear any nudge.
      setTimingPrompt(false);
    }
  }

  // Eraser (desktop edit row): wipe every field on this line so the inspector
  // can re-enter it from scratch. Non-destructive to the SAVED line — clicking
  // out without re-filling just leaves the previously-saved values in place.
  function clearLine() {
    setCategory('');
    setSubcategory('');
    setLineItemCode('');
    setQuantity('');
    setTenantPct(DEFAULT_TENANT_PCT);
    setVendor(DEFAULT_VENDOR);
    setCustomVendorCost('');
    setCustomDescription('');
    setEditTiming(props.resolutionTiming || 'now');
    setTimingChosen(mobile ? true : initialHasTiming);
    setTimingPrompt(false);
    descTouchedRef.current = false;
    tenantTouchedRef.current = false;
  }

  // -------------------------------------------------------------------
  // Save / cancel
  // -------------------------------------------------------------------
  // Desktop-only: an Internal Resolution line must have an explicit Now/Later
  // decision before it's complete. Mobile keeps the default-on behavior.
  const irNeedsTiming = !mobile && isInternalResolution(vendor) && !timingChosen;
  // Required catalog fields, independent of the timing gate. Used by the global
  // commit-all (which bypasses the timing requirement).
  const baseComplete = !!selectedItem && validQuantity && vendor.length > 0;
  const isComplete = baseComplete && !irNeedsTiming;

  function trySave(force = false) {
    // Block leaving an Internal Resolution line until Now/Later is picked.
    // `force` (the global commit-all on Save & Close / Submit) bypasses this so
    // a global save is never silently blocked — it commits with the current
    // timing (defaults to "now").
    if (!force && irNeedsTiming) {
      setTimingPrompt(true);
      return;
    }
    if (!baseComplete || !selectedItem) {
      // Incomplete on leave (e.g. the line was erased then clicked out of):
      // for a brand-new row, discard it; for an existing saved line, REVERT to
      // the saved values. cancelEdit() handles both. Without this we'd exit
      // with wiped local state and render a bogus "not in catalog" orphan row.
      cancelEdit();
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
      // Preserve the saved after-photos (captured in view mode via the in-app
      // camera). Switching the vendor away from Internal Resolution clears them
      // (they're proof-of-work for in-house lines only).
      afterPhotoUrls: isInternalResolution(vendor) ? (line?.afterPhotoUrls || []) : [],
      // Store an override only when it's non-empty AND differs from the catalog
      // default (so an unedited prefill isn't persisted as a custom override).
      customLaborFullDescription: (() => {
        const d = customDescription.trim();
        if (!d) return undefined;
        return d === catalogDescription(selectedItem).trim() ? undefined : d;
      })(),
    };
    onSave(next);
    // Persist the Internal Resolution timing for this line (keyed by its id).
    if (isInternalResolution(vendor)) props.onSetResolutionTiming?.(next.externalId, editTiming);
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
    setEditTiming(props.resolutionTiming || 'now');
    setTimingChosen(mobile ? true : initialHasTiming);
    setTimingPrompt(false);
    setCustomVendorCost(line?.customVendorCost != null ? String(line.customVendorCost) : '');
    setCustomDescription(line?.customLaborFullDescription || '');
    // Keep the description-reset effect from wiping the restored override.
    lastDescItemRef.current = line?.lineItemCode || null;
    descTouchedRef.current = !!line?.customLaborFullDescription;
    const item = line?.lineItemCode ? byCode.get(line.lineItemCode) : null;
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
      // Clicked inside the number keypad (a body-portal overlay, e.g. a tablet
      // using the on-screen pad)? Not "outside" — don't commit mid-entry.
      if (target.closest('[data-numberpad]')) return;
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
      // Global save (Save & Close / Submit): commit even if the Internal
      // Resolution timing wasn't explicitly picked (falls back to "now") so a
      // top-level save is never silently blocked by an open row.
      trySave(true);
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
  }, [isEditing, mobile, isComplete, selectedItem, quantityNum, tenantPct, vendor, customVendorCost, lineItemCode, category, subcategory, timingChosen, editTiming]);

  // -------------------------------------------------------------------
  // Render — VIEW mode
  // -------------------------------------------------------------------
  if (!isEditing) {
    if (!line || !selectedItem) {
      // A saved row whose catalog item can't be resolved. Two cases:
      //   - catalog still loading (catalog.length === 0) → transient; just wait.
      //   - catalog loaded but this code isn't in it → the item was removed/
      //     renamed in HubSpot, leaving an orphan line. Let the inspector delete
      //     it so it can be cleared from the scope/report.
      const catalogLoaded = catalog.length > 0;
      const isOrphan = catalogLoaded && !!line;
      return (
        <tr className="border-b border-gray-100 bg-yellow-50">
          <td colSpan={11} className="px-3 py-2 text-sm text-yellow-800">
            <div className="flex items-center justify-between gap-3">
              <span>
                {isOrphan
                  ? `Line item "${line?.lineItemCode}" is no longer in the catalog (removed or renamed). Delete it to clear it from the report.`
                  : `Catalog item not loaded yet for ${line?.lineItemCode || '(unknown)'}.`}
              </span>
              {isOrphan && !readOnly && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onDelete(); }}
                  className="shrink-0 inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700"
                  title="Delete this orphaned line"
                  aria-label="Delete orphaned line"
                >
                  × Delete line
                </button>
              )}
            </div>
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
        tenantMonths={tenantMonths}
        afterPhotosEnabled={afterPhotosEnabled}
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
        onSaveAfterPhotos={(urls) => onSave({ ...line, afterPhotoUrls: urls })}
        onCaptureAfterPhotos={onCaptureAfterPhotos}
        onOpenAfterPhoto={onOpenAfterPhoto}
        resolutionTiming={props.resolutionTiming}
        onSetResolutionTiming={props.onSetResolutionTiming}
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
                  <ListPicker
                    value={category}
                    options={categories.map((c) => ({ value: c, label: c }))}
                    onChange={handleCategoryChange}
                    ariaLabel="Category"
                    placeholder="Select category…"
                    className={TRIGGER_CLS}
                  />
                </div>

                <div>
                  <label className="block text-xs font-heading font-bold text-gray-700 mb-1">Sub-category</label>
                  <ListPicker
                    value={subcategory}
                    options={subcategories.map((s) => ({ value: s, label: s }))}
                    onChange={handleSubcategoryChange}
                    ariaLabel="Sub-category"
                    placeholder="Select sub-category…"
                    className={TRIGGER_CLS}
                  />
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
                    filled
                    deferKeyboard
                    onFocusChange={setSearchFocused}
                  />
                  {selectedItem && (
                    <textarea
                      value={customDescription}
                      onChange={(e) => { descTouchedRef.current = true; setCustomDescription(e.target.value); }}
                      onFocus={onDescFocus}
                      rows={2}
                      className="w-full mt-2 text-sm bg-gray-100 rounded-lg px-3 py-2 text-gray-700 outline-none focus:ring-2 focus:ring-brand/20"
                      placeholder={catalogDescription(selectedItem) || 'Edit description (optional)…'}
                    />
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-heading font-bold text-gray-700 mb-1">
                      Quantity <span className="text-brand">*</span>
                    </label>
                    {/* Branded in-app keypad (NumberField): inputMode="none" keeps
                        the OS keyboard — and its un-removable autofill/suggestion
                        rows — down, and our own pad drives the value. */}
                    <NumberField
                      value={quantity}
                      onChange={setQuantity}
                      format
                      ariaLabel="Quantity"
                      revealSelector="[data-totals-row]"
                      onFocusField={onQtyFocus}
                      onDone={onQtyBlur}
                      className={`no-spinner ${INPUT_CLS}`}
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
                  <ListPicker
                    value={vendor}
                    options={VENDORS.map((v) => ({ value: v, label: v }))}
                    onChange={handleVendorChange}
                    ariaLabel="Vendor"
                    className={TRIGGER_CLS}
                  />
                </div>

                {/* Internal Resolution: choose completion timing, inline as
                    "Complete: [Now] [Later]". "Now" (default) requires after-
                    photos; "Later" defers them. */}
                {isInternalResolution(vendor) && (
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-heading font-bold text-gray-700 shrink-0">Complete: <span className="text-brand">*</span></span>
                      <div className="grid grid-cols-2 gap-2 flex-1 max-w-xs select-none">
                        {(['now', 'later'] as const).map((v) => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => setEditTiming(v)}
                            className={`h-9 rounded-lg border text-sm text-center leading-none font-heading font-semibold ${editTiming === v ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300'}`}
                          >
                            {v === 'now' ? 'Now' : 'Later'}
                          </button>
                        ))}
                      </div>
                    </div>
                    {editTiming === 'later' && <div className="text-[11px] text-gray-500 mt-1">After photos optional — line marked to complete later.</div>}
                  </div>
                )}

                <div>
                  <label className="block text-xs font-heading font-bold text-gray-700 mb-1">
                    Tenant % <span className="text-brand">*</span>
                    <OverCapAlert
                      category={selectedItem?.category}
                      description={selectedItem?.laborShortDescription}
                      tenantPct={tenantPct}
                      months={tenantMonths}
                      className="ml-1 align-middle"
                    />
                  </label>
                  <WheelPicker
                    value={String(tenantPct)}
                    options={TENANT_PCT_OPTIONS.map((p) => ({ value: String(p), label: `${p}%` }))}
                    onChange={(v) => { tenantTouchedRef.current = true; setTenantPct(Number(v)); }}
                    ariaLabel="Tenant %"
                    className={TRIGGER_CLS}
                  />
                </div>

                {/* Totals row: Vendor $ (editable, with pencil) · Client $ · Tenant $.
                    Vendor $ is blank to use the formula; type to override.
                    data-totals-row: the Qty keypad scrolls this just above itself
                    so the price stays visible and updates live while typing. */}
                <div data-totals-row className="grid grid-cols-3 gap-3 bg-gray-50 rounded-lg p-3 text-center border-2 border-brand/40">
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
                      <NumberField
                        value={customVendorCost}
                        onChange={setCustomVendorCost}
                        revealSelector="[data-totals-row]"
                        placeholder={calc && !calc.isCustomPriced ? formatMoney(roundMoney(calc.vendorCost)) : '0.00'}
                        className="no-spinner bg-transparent border-0 focus:ring-0 p-0 text-base font-semibold text-gray-800 text-center w-16"
                        ariaLabel="Vendor dollar amount (editable)"
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

                {/* After Photos are captured on the saved line card (view mode)
                    via the in-app camera — not here in the field editor. */}

                {/* While the line-item search keyboard is open, grow the card so
                    it can scroll the field WAY up and the dropdown clears the
                    keyboard; collapses when the keyboard closes. */}
                {searchFocused && <div style={{ height: '200vh' }} aria-hidden />}
              </div>

              {/* Sticky footer action — slim so it doesn't eat the sheet. The
                  number keypad hides this while open (data-modal-footer) so its
                  Done is the only dismiss control, then restores it. */}
              <div data-modal-footer className="sticky bottom-0 bg-white border-t border-gray-200 px-4 py-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="flex-1 h-9 rounded-lg border border-gray-300 text-gray-700 font-heading font-semibold text-sm"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => trySave()}
                  disabled={!isComplete}
                  className={`flex-1 h-9 rounded-lg font-heading font-bold text-white text-sm flex items-center justify-center gap-2 ${
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
      {/* Cat — with an eraser button to the left that clears the whole line */}
      <td className="px-2 py-1.5 align-middle min-w-[140px]">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}  // don't blur/commit the row
            onClick={(e) => { e.stopPropagation(); clearLine(); }}
            className="shrink-0 h-9 w-6 rounded flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50"
            title="Clear this line (wipe all fields)"
            aria-label="Clear line"
          >
            {/* eraser icon */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
              <path d="M22 21H7" />
              <path d="m5 11 9 9" />
            </svg>
          </button>
          <select
            value={category}
            onChange={(e) => handleCategoryChange(e.target.value)}
            className="h-9 w-full border border-gray-300 rounded px-2 text-sm bg-white"
            autoFocus
          >
            <option value="">—</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
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
            onFocus={onDescFocus}
            rows={2}
            className="w-full mt-1.5 text-xs border border-gray-300 rounded px-2 py-1 text-gray-700 bg-white"
            placeholder={catalogDescription(selectedItem) || 'Edit description (optional)...'}
            title="Edit the full labor description for this line"
          />
        )}
      </td>
      {/* Qty (center-aligned, no spinner) */}
      <td className="px-2 py-1.5 text-center align-middle">
        <NumberField
          value={quantity}
          onChange={setQuantity}
          format
          ariaLabel="Quantity"
          onFocusField={() => setNativeKeyboardAccessoryBarVisible(false)}
          onDone={() => setNativeKeyboardAccessoryBarVisible(true)}
          className="no-spinner h-9 w-16 border border-gray-300 rounded px-1 text-sm text-center bg-white mx-auto"
        />
      </td>
      {/* Unit (read-only — auto from line item) */}
      <td className="px-2 py-1.5 text-center text-sm text-gray-700 align-middle">
        {selectedItem?.laborMeas || '—'}
      </td>
      {/* Vendor — Internal Resolution reveals a REQUIRED Now/Later choice below
          the dropdown that must be picked before the row can be saved or left.
          The dropdown stays vertically centered (like the other cells) until
          that toggle appears. */}
      <td className="px-2 py-1.5 align-middle min-w-[150px] max-w-[180px]">
        <select
          value={vendor}
          onChange={(e) => handleVendorChange(e.target.value)}
          className="h-9 w-full border border-gray-300 rounded px-1 text-xs bg-white"
          title={vendor}
        >
          {VENDORS.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        {isInternalResolution(vendor) && (
          <div className="mt-1.5 flex items-center gap-1">
            <span className={`text-[11px] font-bold shrink-0 ${timingPrompt && !timingChosen ? 'text-red-600' : 'text-gray-600'}`}>
              Complete:
            </span>
            <div className="grid grid-cols-2 gap-1 flex-1">
              {(['now', 'later'] as const).map((v) => {
                const selected = timingChosen && editTiming === v;
                return (
                  <button
                    key={v}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}  // don't commit the row
                    onClick={(e) => { e.stopPropagation(); setEditTiming(v); setTimingChosen(true); setTimingPrompt(false); }}
                    className={`h-7 rounded text-[11px] font-heading font-semibold border leading-none px-1 ${
                      selected
                        ? 'bg-brand text-white border-brand'
                        : `bg-white text-gray-700 ${timingPrompt && !timingChosen ? 'border-red-400' : 'border-gray-300'}`
                    }`}
                  >
                    {v === 'now' ? 'Now' : 'Later'}
                  </button>
                );
              })}
            </div>
          </div>
        )}
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
        <div className="w-[72px] mx-auto flex items-center justify-center gap-1">
          <select
            value={String(tenantPct)}
            onChange={(e) => { tenantTouchedRef.current = true; setTenantPct(Number(e.target.value)); }}
            className="h-9 w-full border border-gray-300 rounded px-1 text-sm bg-white text-center"
          >
            {TENANT_PCT_OPTIONS.map((p) => (
              <option key={p} value={String(p)}>{p}%</option>
            ))}
          </select>
          <OverCapAlert
            category={selectedItem?.category}
            description={selectedItem?.laborShortDescription}
            tenantPct={tenantPct}
            months={tenantMonths}
          />
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
            title={isComplete ? 'Save line (Enter)' : (irNeedsTiming ? 'Pick Complete Now or Complete Later first' : 'Fill in Category, Line Item, Qty, and Vendor first')}
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
  tenantMonths?: number | null;
  afterPhotosEnabled?: boolean;
  onEnterEdit: () => void;
  onDelete: () => void;
  onOpenPhoto?: (index: number) => void;
  onSaveDescription: (text: string) => void;
  onSaveAfterPhotos: (urls: string[]) => void;
  onCaptureAfterPhotos?: () => void;
  onOpenAfterPhoto?: (index: number) => void;
  // Internal Resolution timing: "now" requires after-photos; "later" defers them.
  resolutionTiming?: 'now' | 'later';
  onSetResolutionTiming?: (lineExternalId: string, v: 'now' | 'later') => void;
}

function ViewRow({ line, item, calc, readOnly, mobile, tenantMonths, afterPhotosEnabled, onEnterEdit, onDelete, onOpenPhoto, onSaveDescription, onSaveAfterPhotos, onCaptureAfterPhotos, onOpenAfterPhoto, resolutionTiming, onSetResolutionTiming }: ViewRowProps) {
  const [showFull, setShowFull] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const descTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const fullDescription = line.customLaborFullDescription || catalogDescription(item);
  const shortDescription = item.laborShortDescription;
  // Quantity + friendly unit shown in parentheses next to the line title, e.g.
  // "Replace Doorstops (3 ea)" / "Sales Clean (1,448 sq ft)".
  const qtyParen = friendlyQtyUnit(line.quantity, item.laborMeas);
  const truncated = fullDescription.length > 120
    ? fullDescription.slice(0, 120).trim() + '…'
    : fullDescription;
  const isTruncated = fullDescription.length > 120;
  const pill = vendorPillStyle(line.assignedTo);
  // Internal Resolution lines split their photos into Before (the tagged
  // section photos) and After (captured in-app). Only once the feature is live.
  const showIrPhotos = !!afterPhotosEnabled && isInternalResolution(line.assignedTo);
  // Resolution timing (Internal Resolution only). Default "now" preserves the
  // existing strict behavior (after-photos required) until switched to "later".
  const timing: 'now' | 'later' = resolutionTiming || 'now';
  const afterRequired = timing !== 'later';
  const timingButtons = (['now', 'later'] as const).map((v) => (
    <button
      key={v}
      type="button"
      disabled={readOnly}
      onClick={(e) => { e.stopPropagation(); onSetResolutionTiming?.(line.externalId, v); }}
      className={`h-7 rounded-md border text-[11px] text-center leading-none font-heading font-semibold ${timing === v ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300'}`}
    >
      {v === 'now' ? 'Now' : 'Later'}
    </button>
  ));
  const completeLabel = <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Complete: <span className="text-brand">*</span></span>;
  const resolutionToggle = showIrPhotos ? (
    mobile ? (
      // Mobile: label on its own line, buttons stacked below.
      <div className="mt-2 w-full" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1">{completeLabel}</div>
        <div className="grid grid-cols-2 gap-1.5 w-full max-w-[160px] select-none">{timingButtons}</div>
      </div>
    ) : (
      // Desktop: COMPLETE: Now Later all on one line.
      <div className="mt-1.5 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <span className="shrink-0">{completeLabel}</span>
        <div className="flex gap-1.5 select-none">
          {(['now', 'later'] as const).map((v) => (
            <button
              key={v}
              type="button"
              disabled={readOnly}
              onClick={(e) => { e.stopPropagation(); onSetResolutionTiming?.(line.externalId, v); }}
              className={`h-7 w-14 rounded-md border text-[11px] text-center leading-none font-heading font-semibold ${timing === v ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300'}`}
            >
              {v === 'now' ? 'Now' : 'Later'}
            </button>
          ))}
        </div>
      </div>
    )
  ) : null;

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
              <div className="text-sm font-medium text-ink leading-snug">
                {shortDescription}
                {qtyParen && <span className="font-normal text-gray-400"> ({qtyParen})</span>}
              </div>
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
              <div className="text-xs text-gray-500 mt-0.5">{subParts}</div>
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
              {/* Complete: Now/Later sits directly under the Internal Resolution
                  chip (same spot the selection was made). */}
              {resolutionToggle}
              {/* Internal Resolution: the tagged section photos read as the
                  BEFORE photos; the After Photos panel (in-app camera) is below. */}
              {showIrPhotos && (line.photoUrls?.length ?? 0) > 0 && (
                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mt-2 mb-1">Before Photos</div>
              )}
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
              {showIrPhotos && (
                <PhotoChipRow
                  label="After Photos"
                  urls={line.afterPhotoUrls || []}
                  required={afterRequired}
                  onAdd={readOnly ? undefined : onCaptureAfterPhotos}
                  onChange={readOnly ? undefined : onSaveAfterPhotos}
                  onOpen={onOpenAfterPhoto}
                  readOnly={readOnly}
                />
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
                <div className="text-[10px] text-brand tabular-nums inline-flex items-center justify-end gap-0.5 w-full">
                  ({line.tenantBillBackPercent}%)
                  <OverCapAlert
                    category={item.category}
                    description={item.laborShortDescription}
                    tenantPct={line.tenantBillBackPercent}
                    months={tenantMonths}
                  />
                </div>
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
        <div className="font-medium text-sm text-ink">
          {shortDescription}
          {qtyParen && <span className="font-normal text-gray-400"> ({qtyParen})</span>}
        </div>
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
        {/* Internal Resolution: COMPLETE: Now/Later directly under the subtext. */}
        {resolutionToggle}
        {/* Internal Resolution: tagged section photos = BEFORE photos; the After
            Photos panel (in-app camera) renders below the strip. */}
        {showIrPhotos && (line.photoUrls?.length ?? 0) > 0 && (
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mt-2 mb-1">Before Photos</div>
        )}
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
        {showIrPhotos && (
          <PhotoChipRow
            label="After Photos"
            urls={line.afterPhotoUrls || []}
            required={afterRequired}
            onAdd={readOnly ? undefined : onCaptureAfterPhotos}
            onChange={readOnly ? undefined : onSaveAfterPhotos}
            onOpen={onOpenAfterPhoto}
            readOnly={readOnly}
          />
        )}
      </td>
      <td className="px-3 py-2 text-center text-sm text-gray-900 tabular-nums whitespace-nowrap">{formatQty(line.quantity)}</td>
      <td className="px-3 py-2 text-center text-sm text-gray-700 whitespace-nowrap">{item.laborMeas}</td>
      <td className="px-3 py-2 text-center align-middle whitespace-nowrap">
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
      <td className="px-3 py-2 text-center text-sm text-gray-700 whitespace-nowrap">
        <span className="inline-flex items-center justify-center gap-1">
          {line.tenantBillBackPercent}%
          <OverCapAlert
            category={item.category}
            description={item.laborShortDescription}
            tenantPct={line.tenantBillBackPercent}
            months={tenantMonths}
          />
        </span>
      </td>
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
