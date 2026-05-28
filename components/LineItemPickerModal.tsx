/**
 * LineItemPickerModal
 *
 * The core UI for adding (or editing) a single rate card line.
 *
 * Order of inputs (v0.16):
 *   1. Category (dropdown)
 *   2. Subcategory (dropdown, narrowed by Category)
 *   3. Labor Description (combobox; type-to-filter; auto-fills Cat/Sub on pick)
 *   4. Full Description (shown expanded by default; collapsible; editable for the labor side)
 *   5. Quantity + Unit
 *   6. Vendor + Tenant %
 *   7. Bid Item overrides (only when is_bid_item)
 *   8. Note
 *   9. Live calculation preview
 *
 * For NEW lines (no initialValue), all fields reset to defaults each open.
 * For EDIT (initialValue present), fields pre-populate.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Combobox } from '@/components/Combobox';
import { VENDORS, vendorPillStyle } from '@/lib/vendors';
import { calculateLine, roundMoney } from '@/lib/rateCardMath';
import { formatMoney } from '@/lib/photoUpload';
import type {
  RateCardLineItem,
  RegionRate,
  RateCardLineInput,
} from '@/lib/types';

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (line: RateCardLineInput) => void;
  catalog: RateCardLineItem[];
  regions: RegionRate[];
  inspectionRegion: string;
  section: string;
  location: string;
  locationDisplay?: string;
  initialValue?: RateCardLineInput | null;
}

const TENANT_PCT_OPTIONS = Array.from({ length: 21 }, (_, i) => i * 5);
const DEFAULT_VENDOR = 'Vendor 1';
const DEFAULT_TENANT_PCT = 100;

function genExternalId(): string {
  return `RCLINE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function LineItemPickerModal({
  open,
  onClose,
  onSave,
  catalog,
  regions,
  inspectionRegion,
  section,
  location,
  locationDisplay,
  initialValue = null,
}: Props) {
  // Form state
  const [lineItemCode, setLineItemCode] = useState<string>('');
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterSubcategory, setFilterSubcategory] = useState<string>('');
  const [quantity, setQuantity] = useState<string>('1');
  const [tenantPct, setTenantPct] = useState<number>(DEFAULT_TENANT_PCT);
  const [assignedTo, setAssignedTo] = useState<string>(DEFAULT_VENDOR);
  const [note, setNote] = useState<string>('');
  const [customDescription, setCustomDescription] = useState<string>('');
  const [descExpanded, setDescExpanded] = useState<boolean>(true);   // expanded by default
  const [customLaborRate, setCustomLaborRate] = useState<string>('');
  const [customMaterialCost, setCustomMaterialCost] = useState<string>('');
  const [customVendorCost, setCustomVendorCost] = useState<string>('');

  // Track whether we've initialized this open of the modal
  const initializedForOpenRef = useRef(false);

  // Reset / preload every time the modal goes from closed -> open.
  // For NEW (no initialValue): all fields blank.
  // For EDIT (initialValue): pre-populate from the line.
  useEffect(() => {
    if (!open) {
      initializedForOpenRef.current = false;
      return;
    }
    if (initializedForOpenRef.current) return;
    initializedForOpenRef.current = true;

    if (initialValue) {
      // Editing existing line
      setLineItemCode(initialValue.lineItemCode || '');
      setQuantity(initialValue.quantity ? String(initialValue.quantity) : '1');
      setTenantPct(initialValue.tenantBillBackPercent ?? DEFAULT_TENANT_PCT);
      setAssignedTo(initialValue.assignedTo || DEFAULT_VENDOR);
      setNote(initialValue.note || '');
      setCustomDescription(initialValue.customLaborFullDescription || '');
      setCustomLaborRate(initialValue.customLaborRate != null ? String(initialValue.customLaborRate) : '');
      setCustomMaterialCost(initialValue.customAdjustedMaterialCost != null ? String(initialValue.customAdjustedMaterialCost) : '');
      setCustomVendorCost(initialValue.customVendorCost != null ? String(initialValue.customVendorCost) : '');
      // Pre-set filters to the line's category
      const item = catalog.find((c) => c.lineItemCode === initialValue.lineItemCode);
      if (item) {
        setFilterCategory(item.category);
        setFilterSubcategory(item.subcategory);
      }
    } else {
      // Fresh new-line state
      setLineItemCode('');
      setFilterCategory('');
      setFilterSubcategory('');
      setQuantity('1');
      setTenantPct(DEFAULT_TENANT_PCT);
      setAssignedTo(DEFAULT_VENDOR);
      setNote('');
      setCustomDescription('');
      setCustomLaborRate('');
      setCustomMaterialCost('');
      setCustomVendorCost('');
      setDescExpanded(true);
    }
  }, [open, initialValue, catalog]);

  // ------------------------------------------------------------------
  // Derived filter lists
  // ------------------------------------------------------------------

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
      if (filterCategory && item.category !== filterCategory) continue;
      if (item.subcategory) set.add(item.subcategory);
    }
    // "Bid Item" always sorts to the top; everything else alphabetical
    return Array.from(set).sort((a, b) => {
      const aIsBid = a === 'Bid Item';
      const bIsBid = b === 'Bid Item';
      if (aIsBid && !bIsBid) return -1;
      if (!aIsBid && bIsBid) return 1;
      return a.localeCompare(b);
    });
  }, [catalog, filterCategory]);

  const filteredLineItems = useMemo(() => {
    return catalog
      .filter((item) => {
        if (filterCategory && item.category !== filterCategory) return false;
        if (filterSubcategory && item.subcategory !== filterSubcategory) return false;
        return true;
      })
      .sort((a, b) => a.laborShortDescription.localeCompare(b.laborShortDescription));
  }, [catalog, filterCategory, filterSubcategory]);

  const selectedItem: RateCardLineItem | null = useMemo(() => {
    if (!lineItemCode) return null;
    return catalog.find((c) => c.lineItemCode === lineItemCode) || null;
  }, [catalog, lineItemCode]);

  // ------------------------------------------------------------------
  // Cascade handlers
  // ------------------------------------------------------------------

  function handleLineItemChange(code: string) {
    setLineItemCode(code);
    if (code) {
      const item = catalog.find((c) => c.lineItemCode === code);
      if (item) {
        setFilterCategory(item.category);
        setFilterSubcategory(item.subcategory);
      }
    }
  }

  function handleCategoryChange(cat: string) {
    setFilterCategory(cat);
    if (selectedItem && selectedItem.category !== cat) {
      setLineItemCode('');
      setFilterSubcategory('');
    }
  }

  function handleSubcategoryChange(sub: string) {
    setFilterSubcategory(sub);
    if (selectedItem && selectedItem.subcategory !== sub) {
      setLineItemCode('');
    }
  }

  // ------------------------------------------------------------------
  // Live calc preview
  // ------------------------------------------------------------------

  const quantityNum = Number(quantity);
  const validQuantity = isFinite(quantityNum) && quantityNum > 0;

  const calc = useMemo(() => {
    if (!selectedItem || !validQuantity || regions.length === 0) return null;
    try {
      return calculateLine(selectedItem, inspectionRegion, regions, {
        quantity: quantityNum,
        tenantBillBackPercent: tenantPct,
        customLaborRate: customLaborRate.trim() === '' ? null : Number(customLaborRate),
        customAdjustedMaterialCost: customMaterialCost.trim() === '' ? null : Number(customMaterialCost),
        customVendorCost: customVendorCost.trim() === '' ? null : Number(customVendorCost),
      });
    } catch (e) {
      console.warn('Live calc failed:', e);
      return null;
    }
  }, [selectedItem, inspectionRegion, regions, quantityNum, validQuantity, tenantPct, customLaborRate, customMaterialCost, customVendorCost]);

  const defaultLaborRate = calc?.laborHourlyRateSnapshot ?? null;
  const defaultMaterialCostAdjusted = useMemo(() => {
    if (!selectedItem) return null;
    if (selectedItem.isLaborOnly) return 0;
    const region = regions.find((r) => r.region === inspectionRegion) || regions.find((r) => r.region === 'GA: Atlanta');
    if (!region) return null;
    return selectedItem.materialCost * (region.materialCostAdjustment ?? 1) * (1 + (region.materialTaxAdjustment ?? 0));
  }, [selectedItem, regions, inspectionRegion]);

  const canSave = !!selectedItem && validQuantity && assignedTo.length > 0;

  function handleSave() {
    if (!canSave || !selectedItem) return;
    const line: RateCardLineInput = {
      externalId: initialValue?.externalId || genExternalId(),
      section,
      location,
      lineItemCode: selectedItem.lineItemCode,
      quantity: quantityNum,
      tenantBillBackPercent: tenantPct,
      assignedTo,
      note,
      customLaborRate: customLaborRate.trim() === '' ? null : Number(customLaborRate),
      customAdjustedMaterialCost: customMaterialCost.trim() === '' ? null : Number(customMaterialCost),
      customVendorCost: customVendorCost.trim() === '' ? null : Number(customVendorCost),
      photoUrls: initialValue?.photoUrls || [],
      customLaborFullDescription: customDescription.trim() || undefined,
    };
    onSave(line);
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  if (!open) return null;

  const heading = locationDisplay || location || section || 'Add Line Item';
  const isBidItem = selectedItem?.isBidItem === true;
  const isLaborOnly = selectedItem?.isLaborOnly === true;

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/50">
      <div className="bg-white w-full sm:max-w-2xl rounded-t-lg sm:rounded-lg shadow-xl max-h-[95vh] flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-ink">
              {initialValue ? 'Edit Line Item' : 'Add Line Item'}
            </h2>
            <div className="text-xs text-gray-500">{heading}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-2xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto px-4 py-4 space-y-4 flex-1">

          {/* 1 & 2: Category + Subcategory */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Category</label>
              <select
                value={filterCategory}
                onChange={(e) => handleCategoryChange(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base bg-white"
              >
                <option value="">(all categories)</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Subcategory</label>
              <select
                value={filterSubcategory}
                onChange={(e) => handleSubcategoryChange(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base bg-white"
              >
                <option value="">(all subcategories)</option>
                {subcategories.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 3: Labor Description (now below Cat/Sub) */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">
              Labor Description
            </label>
            <Combobox
              options={filteredLineItems.map((item) => ({
                value: item.lineItemCode,
                label: item.laborShortDescription,
                sublabel: item.laborFullDescription,
              }))}
              value={lineItemCode}
              onChange={handleLineItemChange}
              placeholder="Type to search items..."
              emptyLabel={filterCategory ? 'No items in this category' : 'No matching items'}
            />
            <div className="text-xs text-gray-500 mt-1">
              {catalog.length > 0
                ? `${filteredLineItems.length} of ${catalog.length} items`
                : 'Loading catalog...'}
            </div>
          </div>

          {/* 4: Full Description (default expanded; collapsible) */}
          {selectedItem && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setDescExpanded((v) => !v)}
                className="w-full px-3 py-2 text-left text-sm font-semibold text-gray-700 flex items-center justify-between hover:bg-gray-100"
              >
                <span>Full Description</span>
                <span className="text-lg">{descExpanded ? '−' : '+'}</span>
              </button>
              {descExpanded && (
                <div className="px-3 pb-3 space-y-2 text-sm">
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                      Labor (editable)
                    </div>
                    <textarea
                      value={customDescription || selectedItem.laborFullDescription}
                      onChange={(e) => setCustomDescription(e.target.value)}
                      rows={4}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                      placeholder="Edit description for this line..."
                    />
                    <div className="text-xs text-gray-400 mt-1">
                      Edits appear on the line card and PDFs.
                    </div>
                  </div>
                  {!isLaborOnly && selectedItem.materialDescription && (
                    <div>
                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                        Material
                      </div>
                      <div className="text-gray-700 px-2 py-1.5 bg-white border border-gray-200 rounded">
                        {selectedItem.materialDescription}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 5: Quantity + Unit */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Quantity</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Unit</label>
              <div className="px-3 py-2.5 border border-gray-200 rounded-lg bg-gray-50 text-base text-gray-700">
                {selectedItem?.laborMeas || '—'}
              </div>
            </div>
          </div>

          {/* 6: Vendor + Tenant % */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Vendor</label>
              <div className="flex items-center gap-2">
                <select
                  value={assignedTo}
                  onChange={(e) => setAssignedTo(e.target.value)}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2.5 text-base bg-white"
                >
                  {VENDORS.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
                {/* Color pill preview of the currently-selected vendor */}
                <span
                  className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap ${vendorPillStyle(assignedTo).bg} ${vendorPillStyle(assignedTo).text} ${vendorPillStyle(assignedTo).border || ''}`}
                  title="This is how the vendor will appear on the line item table"
                >
                  {assignedTo}
                </span>
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Tenant Bill-Back %</label>
              <select
                value={String(tenantPct)}
                onChange={(e) => setTenantPct(Number(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base bg-white"
              >
                {TENANT_PCT_OPTIONS.map((p) => (
                  <option key={p} value={p}>{p}%</option>
                ))}
              </select>
            </div>
          </div>

          {/* Vendor cost override (any line) */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <label className="block text-sm font-semibold text-blue-900 mb-1">
              Vendor Cost Override <span className="font-normal text-blue-700">(optional)</span>
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={customVendorCost}
              onChange={(e) => setCustomVendorCost(e.target.value)}
              placeholder={calc && !calc.isCustomPriced ? `Computed: $${formatMoney(roundMoney(calc.vendorCost))}` : 'Enter total vendor cost'}
              className="w-full border border-blue-300 rounded px-3 py-2 text-base bg-white"
            />
            <div className="text-xs text-blue-800 mt-1">
              Type a number to override the formula. Client = override × 1.20; Tenant applies %.
              Leave blank to use the catalog/region calculation.
            </div>
          </div>

          {/* 7: Bid Item override panel */}
          {isBidItem && selectedItem && (
            <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-3 space-y-3">
              <div className="text-sm font-semibold text-yellow-900">
                ⚡ Bid Item — enter your custom price
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-yellow-900 mb-1">
                    Custom Labor Rate ($/hr)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={customLaborRate}
                    onChange={(e) => setCustomLaborRate(e.target.value)}
                    placeholder={defaultLaborRate != null ? `Default: $${formatMoney(roundMoney(defaultLaborRate))}` : ''}
                    className="w-full border border-yellow-300 rounded px-2 py-1.5 text-sm bg-white"
                  />
                </div>
                {!isLaborOnly && (
                  <div>
                    <label className="block text-xs font-semibold text-yellow-900 mb-1">
                      Custom Adjusted Material Cost ($)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={customMaterialCost}
                      onChange={(e) => setCustomMaterialCost(e.target.value)}
                      placeholder={defaultMaterialCostAdjusted != null ? `Default: $${formatMoney(roundMoney(defaultMaterialCostAdjusted))}` : ''}
                      className="w-full border border-yellow-300 rounded px-2 py-1.5 text-sm bg-white"
                    />
                  </div>
                )}
              </div>
              <div className="text-xs text-yellow-800">
                Leave blank to use catalog/region defaults. Either field can be overridden independently.
              </div>
            </div>
          )}

          {/* 8: Note */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">
              Note <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="Inspector note about this line..."
            />
          </div>

          {/* 9: Live calculation */}
          <div className="bg-brand/5 border-2 border-brand/40 rounded-lg p-3">
            <div className="text-xs font-bold text-gray-600 uppercase tracking-wide mb-2">
              Live Calculation
            </div>
            {calc ? (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Vendor Cost</span>
                  <span className="font-semibold text-ink">${formatMoney(roundMoney(calc.vendorCost))}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Client Cost <span className="text-xs text-gray-400">(+20%)</span></span>
                  <span className="font-semibold text-ink">${formatMoney(roundMoney(calc.clientCost))}</span>
                </div>
                <div className="flex justify-between text-base">
                  <span className="text-brand font-semibold">Tenant Cost ({tenantPct}%)</span>
                  <span className="font-bold text-brand">${formatMoney(roundMoney(calc.tenantCost))}</span>
                </div>
                <div className="mt-2 pt-2 border-t border-brand/20 text-xs text-gray-500">
                  Region: {calc.regionSnapshot || inspectionRegion || 'fallback (GA: Atlanta)'} · Rate ${formatMoney(roundMoney(calc.laborHourlyRateSnapshot))}/hr
                  {calc.isCustomPriced && <span className="ml-2 font-semibold text-yellow-700">· Custom Priced</span>}
                </div>
              </div>
            ) : (
              <div className="text-sm text-gray-500 italic">Select an item and enter quantity to see the calculation.</div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between bg-gray-50 rounded-b-lg">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm border border-gray-300 rounded text-gray-700 hover:bg-gray-100 bg-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className={`px-5 py-2 text-sm font-semibold rounded ${
              canSave
                ? 'bg-brand text-white hover:bg-brand-dark'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            {initialValue ? 'Save Changes' : 'Add Line'}
          </button>
        </div>
      </div>
    </div>
  );
}
