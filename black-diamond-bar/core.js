/*
 * Black Diamond Bar — core business logic.
 *
 * Pure functions that operate on a plain `state` object so they can run in the
 * browser (attached to window.BDCore) and in Node for tests (module.exports).
 * Every function that changes stock also writes an entry to `state.movements`,
 * giving a full audit trail of where each bottle went.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BDCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;

  const DEFAULT_CATEGORIES = ['Beer', 'Cider', 'Spirits', 'Wine', 'Shooters', 'Soft Drinks', 'Snacks', 'Other'];
  const PAYMENT_METHODS = ['Cash', 'Card', 'EFT', 'Tab'];

  function createState() {
    return {
      version: SCHEMA_VERSION,
      settings: {
        barName: 'Black Diamond Bar',
        currency: 'R',
        staff: ['Manager'],
        categories: DEFAULT_CATEGORIES.slice(),
      },
      products: [],
      sales: [],
      deliveries: [],
      stockTakes: [],
      movements: [],
      seq: 1,
    };
  }

  // ---------- helpers ----------

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function nextId(state, prefix) {
    const id = prefix + String(state.seq).padStart(5, '0');
    state.seq += 1;
    return id;
  }

  /** YYYY-MM-DD in local time for an ISO timestamp (or Date). */
  function localDay(value) {
    const d = value instanceof Date ? value : new Date(value);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function inRange(iso, from, to) {
    const day = localDay(iso);
    return (!from || day >= from) && (!to || day <= to);
  }

  function findProduct(state, id) {
    const p = state.products.find((x) => x.id === id);
    if (!p) throw new Error('Product not found: ' + id);
    return p;
  }

  function requireNumber(value, label, { min = 0, integer = false } = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(label + ' must be a number');
    if (n < min) throw new Error(label + ' must be at least ' + min);
    if (integer && !Number.isInteger(n)) throw new Error(label + ' must be a whole number');
    return n;
  }

  function logMovement(state, { productId, type, qty, ref, note, date }) {
    const p = findProduct(state, productId);
    state.movements.push({
      id: nextId(state, 'M'),
      date: date || new Date().toISOString(),
      productId,
      productName: p.name,
      type, // sale | void | receive | stocktake | adjust | opening
      qty, // signed: negative removes stock
      balance: p.stock,
      ref: ref || '',
      note: note || '',
    });
  }

  // ---------- products ----------

  function normaliseProduct(input) {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Product name is required');
    return {
      name,
      category: String(input.category || 'Other').trim() || 'Other',
      unit: String(input.unit || 'each').trim() || 'each',
      costPrice: round2(requireNumber(input.costPrice ?? 0, 'Cost price')),
      sellPrice: round2(requireNumber(input.sellPrice ?? 0, 'Selling price')),
      reorderLevel: requireNumber(input.reorderLevel ?? 0, 'Reorder level', { integer: true }),
      active: input.active !== false,
    };
  }

  function addProduct(state, input) {
    const fields = normaliseProduct(input);
    if (state.products.some((p) => p.name.toLowerCase() === fields.name.toLowerCase())) {
      throw new Error('A product named "' + fields.name + '" already exists');
    }
    const opening = requireNumber(input.stock ?? 0, 'Opening stock', { integer: true });
    const product = { id: nextId(state, 'P'), ...fields, stock: opening };
    state.products.push(product);
    if (opening > 0) logMovement(state, { productId: product.id, type: 'opening', qty: opening, note: 'Opening stock' });
    return product;
  }

  /** Edits product details. Stock is never changed here — use receive/stock take/adjust. */
  function updateProduct(state, id, input) {
    const product = findProduct(state, id);
    const fields = normaliseProduct({ ...product, ...input });
    if (state.products.some((p) => p.id !== id && p.name.toLowerCase() === fields.name.toLowerCase())) {
      throw new Error('A product named "' + fields.name + '" already exists');
    }
    Object.assign(product, fields);
    return product;
  }

  /** Products with history are archived (hidden) rather than removed, to keep reports intact. */
  function deleteProduct(state, id) {
    const product = findProduct(state, id);
    const hasHistory = state.movements.some((m) => m.productId === id && m.type !== 'opening');
    if (hasHistory) {
      product.active = false;
      return 'archived';
    }
    state.products = state.products.filter((p) => p.id !== id);
    state.movements = state.movements.filter((m) => m.productId !== id);
    return 'deleted';
  }

  function adjustStock(state, { productId, qty, reason, staff }) {
    const product = findProduct(state, productId);
    const change = requireNumber(qty, 'Adjustment', { min: -Infinity, integer: true });
    if (change === 0) throw new Error('Adjustment cannot be zero');
    if (!String(reason || '').trim()) throw new Error('A reason is required for adjustments');
    if (product.stock + change < 0) throw new Error('Adjustment would make ' + product.name + ' stock negative');
    product.stock += change;
    logMovement(state, { productId, type: 'adjust', qty: change, note: reason + (staff ? ' (' + staff + ')' : '') });
    return product;
  }

  // ---------- sales ----------

  /**
   * Records a sale. `items` is [{ productId, qty }]. Prices are snapshotted at
   * the time of sale so later price changes don't rewrite history.
   */
  function recordSale(state, { items, payment, staff, date, allowNegative = false }) {
    if (!Array.isArray(items) || items.length === 0) throw new Error('A sale needs at least one item');
    if (!PAYMENT_METHODS.includes(payment)) throw new Error('Unknown payment method: ' + payment);

    // Merge duplicate lines and validate before touching any stock.
    const merged = new Map();
    for (const it of items) {
      const qty = requireNumber(it.qty, 'Quantity', { min: 1, integer: true });
      merged.set(it.productId, (merged.get(it.productId) || 0) + qty);
    }
    const lines = [];
    for (const [productId, qty] of merged) {
      const p = findProduct(state, productId);
      if (!allowNegative && p.stock < qty) {
        throw new Error('Not enough ' + p.name + ' in stock (have ' + p.stock + ', need ' + qty + ')');
      }
      lines.push({
        productId,
        name: p.name,
        category: p.category,
        qty,
        unitPrice: p.sellPrice,
        unitCost: p.costPrice,
        lineTotal: round2(p.sellPrice * qty),
        lineCost: round2(p.costPrice * qty),
      });
    }

    const sale = {
      id: nextId(state, 'S'),
      date: date || new Date().toISOString(),
      staff: staff || '',
      payment,
      lines,
      total: round2(lines.reduce((s, l) => s + l.lineTotal, 0)),
      cost: round2(lines.reduce((s, l) => s + l.lineCost, 0)),
      voided: false,
    };

    for (const l of lines) {
      findProduct(state, l.productId).stock -= l.qty;
      logMovement(state, { productId: l.productId, type: 'sale', qty: -l.qty, ref: sale.id, date: sale.date });
    }
    state.sales.push(sale);
    return sale;
  }

  function voidSale(state, saleId, reason) {
    const sale = state.sales.find((s) => s.id === saleId);
    if (!sale) throw new Error('Sale not found: ' + saleId);
    if (sale.voided) throw new Error('Sale ' + saleId + ' is already voided');
    if (!String(reason || '').trim()) throw new Error('A reason is required to void a sale');
    for (const l of sale.lines) {
      findProduct(state, l.productId).stock += l.qty;
      logMovement(state, { productId: l.productId, type: 'void', qty: l.qty, ref: sale.id, note: reason });
    }
    sale.voided = true;
    sale.voidReason = reason;
    sale.voidedAt = new Date().toISOString();
    return sale;
  }

  // ---------- stock in ----------

  /** Records a delivery. `items` is [{ productId, qty, unitCost? }]. Updates cost price if given. */
  function receiveStock(state, { items, supplier, invoice, staff, date }) {
    if (!Array.isArray(items) || items.length === 0) throw new Error('A delivery needs at least one item');
    const lines = items.map((it) => {
      const p = findProduct(state, it.productId);
      const qty = requireNumber(it.qty, 'Quantity', { min: 1, integer: true });
      const hasCost = it.unitCost !== undefined && it.unitCost !== '' && it.unitCost !== null;
      const unitCost = hasCost ? round2(requireNumber(it.unitCost, 'Unit cost')) : p.costPrice;
      return { productId: p.id, name: p.name, qty, unitCost, lineCost: round2(unitCost * qty) };
    });
    const delivery = {
      id: nextId(state, 'D'),
      date: date || new Date().toISOString(),
      supplier: String(supplier || '').trim(),
      invoice: String(invoice || '').trim(),
      staff: staff || '',
      lines,
      total: round2(lines.reduce((s, l) => s + l.lineCost, 0)),
    };
    for (const l of lines) {
      const p = findProduct(state, l.productId);
      p.stock += l.qty;
      p.costPrice = l.unitCost;
      logMovement(state, { productId: p.id, type: 'receive', qty: l.qty, ref: delivery.id, date: delivery.date, note: delivery.supplier });
    }
    state.deliveries.push(delivery);
    return delivery;
  }

  // ---------- stock take ----------

  /**
   * Records a physical count. `counts` maps productId -> counted quantity.
   * Products not in `counts` are left alone. Stock is set to the counted
   * figure and the difference is logged as a variance (shrinkage if negative).
   */
  function recordStockTake(state, { counts, staff, note, date }) {
    const ids = Object.keys(counts || {});
    if (ids.length === 0) throw new Error('Enter at least one count');
    const when = date || new Date().toISOString();
    const lines = ids.map((productId) => {
      const p = findProduct(state, productId);
      const counted = requireNumber(counts[productId], 'Count for ' + p.name, { integer: true });
      const variance = counted - p.stock;
      return {
        productId,
        name: p.name,
        expected: p.stock,
        counted,
        variance,
        varianceValue: round2(variance * p.costPrice),
      };
    });
    const take = {
      id: nextId(state, 'T'),
      date: when,
      staff: staff || '',
      note: String(note || '').trim(),
      lines,
      totalVarianceValue: round2(lines.reduce((s, l) => s + l.varianceValue, 0)),
    };
    for (const l of lines) {
      findProduct(state, l.productId).stock = l.counted;
      if (l.variance !== 0) {
        logMovement(state, { productId: l.productId, type: 'stocktake', qty: l.variance, ref: take.id, date: when, note: 'Count variance' });
      }
    }
    state.stockTakes.push(take);
    return take;
  }

  // ---------- reporting ----------

  function salesReport(state, { from, to } = {}) {
    const sales = state.sales.filter((s) => !s.voided && inRange(s.date, from, to));
    const byProduct = new Map();
    const byPayment = {};
    const byStaff = {};
    const byDay = {};
    const byHour = Array(24).fill(0);
    let revenue = 0;
    let cost = 0;
    let units = 0;

    for (const s of sales) {
      revenue += s.total;
      cost += s.cost;
      byPayment[s.payment] = round2((byPayment[s.payment] || 0) + s.total);
      const who = s.staff || 'Unassigned';
      byStaff[who] = round2((byStaff[who] || 0) + s.total);
      const day = localDay(s.date);
      byDay[day] = round2((byDay[day] || 0) + s.total);
      byHour[new Date(s.date).getHours()] += s.total;
      for (const l of s.lines) {
        units += l.qty;
        const row = byProduct.get(l.productId) || { productId: l.productId, name: l.name, category: l.category, qty: 0, revenue: 0, cost: 0 };
        row.qty += l.qty;
        row.revenue = round2(row.revenue + l.lineTotal);
        row.cost = round2(row.cost + l.lineCost);
        byProduct.set(l.productId, row);
      }
    }

    const products = [...byProduct.values()]
      .map((r) => ({ ...r, profit: round2(r.revenue - r.cost) }))
      .sort((a, b) => b.revenue - a.revenue);

    revenue = round2(revenue);
    cost = round2(cost);
    return {
      from,
      to,
      transactions: sales.length,
      voids: state.sales.filter((s) => s.voided && inRange(s.date, from, to)).length,
      units,
      revenue,
      cost,
      profit: round2(revenue - cost),
      margin: revenue > 0 ? round2(((revenue - cost) / revenue) * 100) : 0,
      averageSale: sales.length ? round2(revenue / sales.length) : 0,
      products,
      byPayment,
      byStaff,
      byDay,
      byHour: byHour.map(round2),
    };
  }

  function stockSummary(state) {
    const active = state.products.filter((p) => p.active);
    return {
      products: active.length,
      units: active.reduce((s, p) => s + p.stock, 0),
      costValue: round2(active.reduce((s, p) => s + p.stock * p.costPrice, 0)),
      retailValue: round2(active.reduce((s, p) => s + p.stock * p.sellPrice, 0)),
      lowStock: active.filter((p) => p.stock <= p.reorderLevel).sort((a, b) => a.stock - b.stock),
      outOfStock: active.filter((p) => p.stock <= 0),
    };
  }

  // ---------- import / export ----------

  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(headers, rows) {
    return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  }

  /** Validates and upgrades a backup file, returning a usable state. */
  function loadState(raw) {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || typeof data !== 'object' || !Array.isArray(data.products)) {
      throw new Error('This does not look like a Black Diamond backup file');
    }
    const base = createState();
    return {
      ...base,
      ...data,
      settings: { ...base.settings, ...(data.settings || {}) },
      sales: data.sales || [],
      deliveries: data.deliveries || [],
      stockTakes: data.stockTakes || [],
      movements: data.movements || [],
      seq: data.seq || 1,
      version: SCHEMA_VERSION,
    };
  }

  return {
    SCHEMA_VERSION,
    PAYMENT_METHODS,
    DEFAULT_CATEGORIES,
    createState,
    loadState,
    round2,
    localDay,
    addProduct,
    updateProduct,
    deleteProduct,
    adjustStock,
    recordSale,
    voidSale,
    receiveStock,
    recordStockTake,
    salesReport,
    stockSummary,
    toCSV,
  };
});
