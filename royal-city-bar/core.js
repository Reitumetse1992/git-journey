/*
 * Royal City Bar — core business logic.
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
  const VOID_REASONS = ['Wrong item rung up', 'Wrong quantity', 'Duplicate sale', 'Wrong payment method', 'Customer changed mind', 'Other'];
  const WRITE_OFF_REASONS = ['Broken', 'Spilled', 'Damaged packaging', 'Expired', 'Spoiled / flat', 'Other'];
  const DAY_MS = 24 * 60 * 60 * 1000;

  function createState() {
    return {
      version: SCHEMA_VERSION,
      settings: {
        barName: 'Royal City Bar',
        currency: 'R',
        staff: ['Manager'],
        managers: ['Manager'], // staff who may authorise voids
        managerPins: {}, // optional PIN per manager
        categories: DEFAULT_CATEGORIES.slice(),
        expiryWarningDays: 30,
      },
      products: [],
      sales: [],
      deliveries: [],
      stockTakes: [],
      writeOffs: [],
      orders: [], // purchase orders sent to suppliers
      batches: [], // expiry-dated lots: { id, productId, expiry, qty, source, ref, note, date }
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

  /** Whole days from `fromDay` to `toDay` (both YYYY-MM-DD). Negative if toDay is earlier. */
  function daysBetween(fromDay, toDay) {
    const [y1, m1, d1] = fromDay.split('-').map(Number);
    const [y2, m2, d2] = toDay.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
  }

  function requireDay(value, label) {
    const s = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new Error(label + ' must be a valid date');
    return s;
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
      type, // sale | void | receive | stocktake | adjust | writeoff | opening
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
      parLevel: requireNumber(input.parLevel === '' || input.parLevel == null ? 0 : input.parLevel, 'Order up to', { integer: true }),
      supplier: String(input.supplier || '').trim(),
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

  /** Staff who may authorise voids. If none are set up, anyone on the staff list may. */
  function voidAuthorisers(state) {
    const managers = (state.settings.managers || []).filter((m) => state.settings.staff.includes(m));
    return managers.length ? managers : state.settings.staff.slice();
  }

  /**
   * Voids a sale and returns its stock. A void is a correction, so it records
   * who asked for it (`voidedBy`, usually the person on shift) and the manager
   * who authorised it (`authorisedBy`), checking that manager's PIN if one is set.
   */
  function voidSale(state, saleId, { reason, voidedBy, authorisedBy, pin, date } = {}) {
    const sale = state.sales.find((s) => s.id === saleId);
    if (!sale) throw new Error('Sale not found: ' + saleId);
    if (sale.voided) throw new Error('Sale ' + saleId + ' is already voided');
    const why = String(reason || '').trim();
    if (!why) throw new Error('A reason is required to void a sale');
    if (!authorisedBy) throw new Error('A manager must authorise the void');
    if (!voidAuthorisers(state).includes(authorisedBy)) throw new Error(authorisedBy + ' is not allowed to authorise voids');
    const expectedPin = (state.settings.managerPins || {})[authorisedBy];
    if (expectedPin && String(pin || '') !== String(expectedPin)) throw new Error('Incorrect PIN for ' + authorisedBy);

    const when = date || new Date().toISOString();
    for (const l of sale.lines) {
      findProduct(state, l.productId).stock += l.qty;
      logMovement(state, { productId: l.productId, type: 'void', qty: l.qty, ref: sale.id, date: when, note: why + ' (authorised by ' + authorisedBy + ')' });
    }
    sale.voided = true;
    sale.voidReason = why;
    sale.voidedAt = when;
    sale.voidedBy = voidedBy || '';
    sale.authorisedBy = authorisedBy;
    return sale;
  }

  /**
   * Per-person sales and voids for a period, plus a log of every void.
   * Sales count by the day they were made; voids by the day they were voided.
   */
  function staffReport(state, { from, to } = {}) {
    const rows = new Map();
    const row = (name) => {
      const key = name || 'Unassigned';
      if (!rows.has(key)) rows.set(key, { name: key, sales: 0, revenue: 0, items: 0, voidedSales: 0, voidedValue: 0, voidsRequested: 0, voidsAuthorised: 0 });
      return rows.get(key);
    };
    for (const s of state.sales) {
      if (!inRange(s.date, from, to)) continue;
      const r = row(s.staff);
      if (s.voided) {
        r.voidedSales += 1;
        r.voidedValue = round2(r.voidedValue + s.total);
      } else {
        r.sales += 1;
        r.revenue = round2(r.revenue + s.total);
        r.items += s.lines.reduce((n, l) => n + l.qty, 0);
      }
    }
    const voids = state.sales
      .filter((s) => s.voided && inRange(s.voidedAt, from, to))
      .sort((a, b) => (a.voidedAt < b.voidedAt ? 1 : -1))
      .map((s) => ({
        saleId: s.id,
        saleDate: s.date,
        voidedAt: s.voidedAt,
        madeBy: s.staff || 'Unassigned',
        voidedBy: s.voidedBy || '',
        authorisedBy: s.authorisedBy || '',
        reason: s.voidReason || '',
        total: s.total,
        lines: s.lines,
        selfAuthorised: !!s.authorisedBy && s.authorisedBy === s.staff,
      }));
    for (const v of voids) {
      if (v.voidedBy) row(v.voidedBy).voidsRequested += 1;
      if (v.authorisedBy) row(v.authorisedBy).voidsAuthorised += 1;
    }
    return {
      rows: [...rows.values()].sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name)),
      voids,
      voidValue: round2(voids.reduce((n, v) => n + v.total, 0)),
    };
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
      const expiry = it.expiry ? requireDay(it.expiry, 'Expiry date for ' + p.name) : '';
      return { productId: p.id, name: p.name, qty, unitCost, lineCost: round2(unitCost * qty), expiry };
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
      if (!p.supplier && delivery.supplier) p.supplier = delivery.supplier; // learn who supplies it
      logMovement(state, { productId: p.id, type: 'receive', qty: l.qty, ref: delivery.id, date: delivery.date, note: delivery.supplier });
      if (l.expiry) {
        state.batches.push({ id: nextId(state, 'B'), productId: p.id, expiry: l.expiry, qty: l.qty, source: 'delivery', ref: delivery.id, note: delivery.supplier, date: delivery.date });
      }
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

  // ---------- damaged stock (write-offs) ----------

  /** Removes damaged, spilled or expired stock and keeps a record of its cost. */
  function recordWriteOff(state, { productId, qty, reason, note, staff, date }) {
    const p = findProduct(state, productId);
    const n = requireNumber(qty, 'Quantity', { min: 1, integer: true });
    if (!WRITE_OFF_REASONS.includes(reason)) throw new Error('Choose a reason for the write-off');
    if (n > p.stock) throw new Error('Cannot write off ' + n + ' ' + p.name + ' — only ' + p.stock + ' in stock');
    const w = {
      id: nextId(state, 'W'),
      date: date || new Date().toISOString(),
      productId: p.id,
      name: p.name,
      category: p.category,
      qty: n,
      unitCost: p.costPrice,
      value: round2(n * p.costPrice),
      reason,
      note: String(note || '').trim(),
      staff: staff || '',
    };
    p.stock -= n;
    logMovement(state, { productId: p.id, type: 'writeoff', qty: -n, ref: w.id, date: w.date, note: reason + (w.note ? ' — ' + w.note : '') });
    state.writeOffs.push(w);
    return w;
  }

  function writeOffReport(state, { from, to } = {}) {
    const list = state.writeOffs.filter((w) => inRange(w.date, from, to)).sort((a, b) => (a.date < b.date ? 1 : -1));
    const byReason = {};
    const byProduct = {};
    for (const w of list) {
      byReason[w.reason] = round2((byReason[w.reason] || 0) + w.value);
      byProduct[w.name] = round2((byProduct[w.name] || 0) + w.value);
    }
    return {
      list,
      units: list.reduce((s, w) => s + w.qty, 0),
      value: round2(list.reduce((s, w) => s + w.value, 0)),
      byReason,
      byProduct,
    };
  }

  // ---------- expiry tracking ----------

  /** Records an expiry date for stock already on the shelf (e.g. opening stock). Does not change stock. */
  function addExpiryBatch(state, { productId, qty, expiry, note }) {
    const p = findProduct(state, productId);
    const batch = {
      id: nextId(state, 'B'),
      productId: p.id,
      expiry: requireDay(expiry, 'Expiry date'),
      qty: requireNumber(qty, 'Quantity', { min: 1, integer: true }),
      source: 'manual',
      ref: '',
      note: String(note || '').trim(),
      date: new Date().toISOString(),
    };
    state.batches.push(batch);
    return batch;
  }

  function removeExpiryBatch(state, batchId) {
    const before = state.batches.length;
    state.batches = state.batches.filter((b) => b.id !== batchId);
    if (state.batches.length === before) throw new Error('Expiry record not found');
  }

  /**
   * Estimates what is left of each dated batch. Assumes stock is rotated
   * first-expiry-first-out, so the units still on the shelf belong to the
   * latest-expiring batches; older batches are used up first. Sales, voids,
   * write-offs and stock takes are therefore all reflected automatically.
   */
  function batchBalances(state) {
    const out = [];
    for (const p of state.products) {
      let left = Math.max(p.stock, 0);
      const batches = state.batches.filter((b) => b.productId === p.id).sort((a, b) => (a.expiry < b.expiry ? 1 : a.expiry > b.expiry ? -1 : 0));
      for (const b of batches) {
        const remaining = Math.min(b.qty, left);
        left -= remaining;
        out.push({ ...b, product: p, remaining });
      }
    }
    return out;
  }

  /** Dated stock that has expired or will expire within `withinDays`, soonest first. */
  function expiryReport(state, { withinDays, today } = {}) {
    const day = today || localDay(new Date());
    const window = withinDays ?? state.settings.expiryWarningDays ?? 30;
    const rows = batchBalances(state)
      .filter((b) => b.remaining > 0 && b.product.active)
      .map((b) => {
        const daysLeft = daysBetween(day, b.expiry);
        const status = daysLeft < 0 ? 'expired' : daysLeft <= 7 ? 'week' : daysLeft <= window ? 'soon' : 'ok';
        return { ...b, daysLeft, status, value: round2(b.remaining * b.product.costPrice) };
      })
      .filter((b) => b.status !== 'ok')
      .sort((a, b) => a.daysLeft - b.daysLeft);
    return {
      rows,
      expired: rows.filter((r) => r.status === 'expired'),
      units: rows.reduce((s, r) => s + r.remaining, 0),
      value: round2(rows.reduce((s, r) => s + r.value, 0)),
      withinDays: window,
    };
  }

  // ---------- restocking ----------

  /**
   * What needs to be ordered. A product is listed when it is at or below its
   * reorder level, or when recent sales say it will run out within
   * `coverDays`. Suggested quantity tops it up to its "order up to" (par)
   * level, or — if none is set — to twice the reorder level or a week of sales.
   */
  function restockList(state, { today, lookbackDays = 14, coverDays = 7 } = {}) {
    const day = today || localDay(new Date());
    const start = new Date(day + 'T00:00:00');
    start.setDate(start.getDate() - (lookbackDays - 1));
    const sold = salesReport(state, { from: localDay(start), to: day }).products;
    const onOrder = onOrderQuantities(state);
    const rows = [];
    for (const p of state.products.filter((x) => x.active)) {
      const qtySold = (sold.find((s) => s.productId === p.id) || { qty: 0 }).qty;
      const perDay = qtySold / lookbackDays;
      const daysLeft = perDay > 0 ? Math.floor(p.stock / perDay) : null;
      const below = p.stock <= p.reorderLevel;
      const runningOut = daysLeft !== null && daysLeft <= coverDays;
      if (!below && !runningOut) continue;
      const target = p.parLevel > 0 ? p.parLevel : Math.max(p.reorderLevel * 2, Math.ceil(perDay * coverDays), p.reorderLevel + 1);
      const incoming = onOrder.get(p.id) || 0;
      const orderQty = Math.max(target - p.stock - incoming, 0);
      rows.push({
        product: p,
        onOrder: incoming,
        status: p.stock <= 0 ? 'out' : below ? 'low' : 'soon',
        perDay: round2(perDay),
        daysLeft,
        target,
        orderQty,
        orderValue: round2(orderQty * p.costPrice),
      });
    }
    const rank = { out: 0, low: 1, soon: 2 };
    rows.sort((a, b) => rank[a.status] - rank[b.status] || (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9) || a.product.name.localeCompare(b.product.name));
    return { rows, orderValue: round2(rows.reduce((s, r) => s + r.orderValue, 0)), lookbackDays, coverDays };
  }

  // ---------- supplier orders ----------

  /** Units ordered from suppliers but not delivered yet, per product. */
  function onOrderQuantities(state) {
    const out = new Map();
    for (const o of state.orders || []) {
      if (o.status !== 'ordered' && o.status !== 'part') continue;
      for (const l of o.lines) out.set(l.productId, (out.get(l.productId) || 0) + Math.max(l.qty - l.received, 0));
    }
    return out;
  }

  /**
   * Orders the system thinks should be placed now: the restock list, less
   * anything already on order, grouped into one order per supplier.
   */
  function suggestedOrders(state, options) {
    const groups = new Map();
    for (const r of restockList(state, options).rows) {
      if (r.orderQty <= 0) continue;
      const supplier = r.product.supplier || '';
      if (!groups.has(supplier)) groups.set(supplier, { supplier, lines: [], total: 0 });
      const g = groups.get(supplier);
      g.lines.push({ productId: r.product.id, name: r.product.name, unit: r.product.unit, qty: r.orderQty, unitCost: r.product.costPrice, lineCost: r.orderValue, status: r.status });
      g.total = round2(g.total + r.orderValue);
    }
    return [...groups.values()].sort((a, b) => (a.supplier === '') - (b.supplier === '') || a.supplier.localeCompare(b.supplier));
  }

  function placeOrder(state, { supplier, items, staff, note, date }) {
    const name = String(supplier || '').trim();
    if (!name) throw new Error('Choose a supplier for this order');
    const lines = (items || [])
      .map((it) => ({ p: findProduct(state, it.productId), qty: requireNumber(it.qty || 0, 'Quantity', { integer: true }) }))
      .filter((x) => x.qty > 0)
      .map(({ p, qty }) => ({ productId: p.id, name: p.name, unit: p.unit, qty, unitCost: p.costPrice, lineCost: round2(qty * p.costPrice), received: 0 }));
    if (!lines.length) throw new Error('An order needs at least one item');
    const order = {
      id: nextId(state, 'O'),
      date: date || new Date().toISOString(),
      supplier: name,
      staff: staff || '',
      note: String(note || '').trim(),
      status: 'ordered', // ordered | part | received | cancelled
      lines,
      total: round2(lines.reduce((n, l) => n + l.lineCost, 0)),
      deliveries: [],
    };
    for (const l of lines) {
      const p = findProduct(state, l.productId);
      if (!p.supplier) p.supplier = name;
    }
    state.orders.push(order);
    return order;
  }

  function findOrder(state, id) {
    const o = (state.orders || []).find((x) => x.id === id);
    if (!o) throw new Error('Order not found: ' + id);
    return o;
  }

  /**
   * Books in a delivery against an order. `lines` gives what actually arrived
   * ([{ productId, qty, unitCost?, expiry? }]); leave it out to receive
   * everything still outstanding at the ordered quantities.
   */
  function receiveOrder(state, orderId, { lines, invoice, staff, date } = {}) {
    const order = findOrder(state, orderId);
    if (order.status !== 'ordered' && order.status !== 'part') throw new Error('Order ' + order.id + ' is already ' + order.status);
    const arriving = lines || order.lines.map((l) => ({ productId: l.productId, qty: l.qty - l.received }));
    const items = arriving.filter((a) => Number(a.qty) > 0);
    for (const a of items) {
      if (!order.lines.some((l) => l.productId === a.productId)) throw new Error('That product is not on order ' + order.id);
    }
    if (!items.length) throw new Error('Enter how many of each item arrived');
    const delivery = receiveStock(state, { items, supplier: order.supplier, invoice: invoice || order.id, staff, date });
    delivery.orderId = order.id;
    for (const dl of delivery.lines) order.lines.find((l) => l.productId === dl.productId).received += dl.qty;
    order.deliveries.push(delivery.id);
    order.status = order.lines.every((l) => l.received >= l.qty) ? 'received' : 'part';
    if (order.status === 'received') order.receivedAt = delivery.date;
    return { order, delivery };
  }

  /** Stops waiting for the rest of an order (cancels it if nothing arrived). */
  function closeOrder(state, orderId, reason) {
    const order = findOrder(state, orderId);
    if (order.status !== 'ordered' && order.status !== 'part') throw new Error('Order ' + order.id + ' is already ' + order.status);
    order.status = order.lines.some((l) => l.received > 0) ? 'received' : 'cancelled';
    order.closedReason = String(reason || '').trim();
    order.closedAt = new Date().toISOString();
    return order;
  }

  /** Plain-text order to send to the supplier by WhatsApp, SMS or email. */
  function orderMessage(state, order) {
    const when = new Date(order.date).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
    const items = order.lines.map((l) => '- ' + l.qty + ' x ' + l.name + (l.unit && l.unit !== 'each' ? ' (' + l.unit + ')' : ''));
    const parts = ['Order ' + order.id + ' from ' + state.settings.barName + '\n' + when, items.join('\n')];
    if (order.note) parts.push(order.note);
    parts.push('Please confirm availability and delivery date. Thank you.');
    return parts.join('\n\n');
  }

  // ---------- import ----------

  const IMPORT_COLUMNS = {
    name: ['name', 'product', 'item', 'description'],
    category: ['category', 'type', 'group'],
    unit: ['unit', 'size', 'measure'],
    costPrice: ['cost', 'cost price', 'buy price', 'buying price', 'unit cost'],
    sellPrice: ['price', 'selling price', 'sell price', 'sale price', 'retail'],
    stock: ['stock', 'qty', 'quantity', 'on hand', 'opening stock', 'count'],
    reorderLevel: ['reorder', 'reorder level', 'reorder at', 'min', 'minimum'],
    parLevel: ['order up to', 'par', 'par level', 'max', 'maximum'],
    supplier: ['supplier', 'vendor', 'from'],
  };
  const IMPORT_DEFAULT_ORDER = ['name', 'category', 'unit', 'costPrice', 'sellPrice', 'stock', 'reorderLevel', 'supplier'];

  /** "R 1 234,50" -> "1234.50"; also accepts 13.50 and 1,200. */
  function toNumberText(v) {
    let t = String(v).trim();
    if (!t.includes('.') && /,\d{1,2}$/.test(t)) t = t.replace(/,(\d{1,2})$/, '.$1');
    return t.replace(/[^0-9.\-]/g, '');
  }

  function parseTable(text) {
    const rows = [];
    for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
      if (!raw.trim()) continue;
      const delim = raw.includes('\t') ? '\t' : raw.includes(';') && !raw.includes(',') ? ';' : ',';
      const cells = [];
      let cur = '';
      let quoted = false;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (quoted) {
          if (ch === '"' && raw[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === delim) { cells.push(cur.trim()); cur = ''; } else cur += ch;
      }
      cells.push(cur.trim());
      rows.push(cells);
    }
    return rows;
  }

  /**
   * Adds or updates products from a spreadsheet (pasted from Excel / Google
   * Sheets, or a CSV file). Matches existing products by name. Stock is only
   * set for new products; existing stock changes through deliveries and counts.
   */
  function importProducts(state, text) {
    const rows = parseTable(text);
    if (!rows.length) throw new Error('Nothing to import — paste rows from your spreadsheet first');
    const norm = (h) => h.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
    const headerMap = rows[0].map((h) => Object.keys(IMPORT_COLUMNS).find((k) => IMPORT_COLUMNS[k].includes(norm(h))) || null);
    const hasHeader = headerMap.includes('name');
    const columns = hasHeader ? headerMap : IMPORT_DEFAULT_ORDER;
    const result = { added: 0, updated: 0, skipped: [] };
    rows.slice(hasHeader ? 1 : 0).forEach((cells, i) => {
      const line = i + (hasHeader ? 2 : 1);
      const rec = {};
      columns.forEach((key, c) => {
        if (key && cells[c] !== undefined && cells[c] !== '') rec[key] = key === 'name' || key === 'category' || key === 'unit' || key === 'supplier' ? cells[c] : toNumberText(cells[c]);
      });
      try {
        if (!rec.name) throw new Error('no product name');
        const existing = state.products.find((p) => p.name.toLowerCase() === rec.name.trim().toLowerCase());
        if (existing) {
          const { stock, ...changes } = rec;
          updateProduct(state, existing.id, { ...changes, active: true });
          result.updated += 1;
        } else {
          addProduct(state, rec);
          result.added += 1;
        }
      } catch (e) {
        result.skipped.push({ line, name: rec.name || '', reason: e.message });
      }
    });
    return result;
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
      throw new Error('This does not look like a Royal City Bar backup file');
    }
    const base = createState();
    const settings = { ...base.settings, ...(data.settings || {}) };
    // Backups made before void authorisation existed: let the first staff member authorise.
    if (!data.settings || !Array.isArray(data.settings.managers)) {
      settings.managers = settings.staff.includes('Manager') ? ['Manager'] : settings.staff.slice(0, 1);
    }
    return {
      ...base,
      ...data,
      settings,
      sales: data.sales || [],
      deliveries: data.deliveries || [],
      stockTakes: data.stockTakes || [],
      writeOffs: data.writeOffs || [],
      orders: data.orders || [],
      batches: data.batches || [],
      movements: data.movements || [],
      seq: data.seq || 1,
      version: SCHEMA_VERSION,
    };
  }

  return {
    SCHEMA_VERSION,
    PAYMENT_METHODS,
    VOID_REASONS,
    WRITE_OFF_REASONS,
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
    voidAuthorisers,
    staffReport,
    receiveStock,
    recordStockTake,
    recordWriteOff,
    writeOffReport,
    addExpiryBatch,
    removeExpiryBatch,
    expiryReport,
    restockList,
    suggestedOrders,
    placeOrder,
    receiveOrder,
    closeOrder,
    orderMessage,
    onOrderQuantities,
    importProducts,
    salesReport,
    stockSummary,
    toCSV,
  };
});
