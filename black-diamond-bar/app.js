/* Black Diamond Bar — user interface. Business rules live in core.js. */
(function () {
  'use strict';

  const C = window.BDCore;
  const STORAGE_KEY = 'blackDiamondBar.v1';
  const STAFF_KEY = 'blackDiamondBar.currentStaff';
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  // ---------- persistence ----------

  let state = load();
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? C.loadState(raw) : C.createState();
    } catch (e) {
      console.error(e);
      return C.createState();
    }
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Could not save — browser storage is full or blocked. Export a backup now.', true);
    }
  }

  /** Runs a mutation, saves and re-renders. Errors become a toast. */
  function act(fn, okMessage) {
    try {
      const result = fn();
      save();
      render();
      if (okMessage) toast(typeof okMessage === 'function' ? okMessage(result) : okMessage);
      return result;
    } catch (e) {
      toast(e.message, true);
      return undefined;
    }
  }

  // ---------- formatting ----------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => {
    const v = Number(n) || 0;
    const sign = v < 0 ? '-' : '';
    return sign + state.settings.currency + ' ' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDateTime = (iso) => new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const today = () => C.localDay(new Date());
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return C.localDay(d); };
  const signed = (n) => (n > 0 ? '+' : '') + n;
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const currentStaff = () => $('#staffSelect').value || '';
  const activeProducts = () => state.products.filter((p) => p.active).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  function stockPill(p) {
    if (p.stock <= 0) return '<span class="pill bad">Out</span>';
    if (p.stock <= p.reorderLevel) return '<span class="pill warn">Low</span>';
    return '<span class="pill good">OK</span>';
  }

  function download(filename, text, type = 'text/csv') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- toast & modal ----------

  let toastTimer;
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ''), bad ? 4500 : 2500);
  }

  let modalSubmit = null;
  function openModal({ title, body, okText = 'Save', onSubmit, onOpen, danger = false }) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = body;
    $('#modalError').textContent = '';
    const ok = $('#modalOk');
    ok.textContent = okText;
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    modalSubmit = onSubmit;
    $('#modal').showModal();
    if (onOpen) onOpen($('#modalBody'));
    const first = $('#modalBody input, #modalBody select, #modalBody textarea');
    if (first) first.focus();
  }
  $('#modalForm').addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      const msg = modalSubmit && modalSubmit(new FormData(e.target), $('#modalBody'));
      save();
      $('#modal').close();
      render();
      if (msg) toast(msg);
    } catch (err) {
      $('#modalError').textContent = err.message;
    }
  });
  $('#modalCancel').addEventListener('click', () => $('#modal').close());

  function productOptions(selected) {
    return activeProducts().map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)} (${p.stock})</option>`).join('');
  }

  // ---------- navigation ----------

  let view = location.hash.slice(1) || 'dashboard';
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    view = b.dataset.view;
    history.replaceState(null, '', '#' + view);
    render();
  });

  function renderStaff() {
    const sel = $('#staffSelect');
    const remembered = localStorage.getItem(STAFF_KEY);
    const current = sel.value || remembered || state.settings.staff[0] || '';
    sel.innerHTML = state.settings.staff.map((s) => `<option ${s === current ? 'selected' : ''}>${esc(s)}</option>`).join('');
  }
  $('#staffSelect').addEventListener('change', (e) => {
    try { localStorage.setItem(STAFF_KEY, e.target.value); } catch (_) { /* ignore */ }
  });

  function render() {
    $('#barName').textContent = state.settings.barName;
    document.title = state.settings.barName + ' · Stock & Sales';
    renderStaff();
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    const alerts = C.restockList(state).rows.length + C.expiryReport(state).rows.filter((r) => r.status !== 'soon').length;
    $('#watchBadge').textContent = alerts || '';
    const views = { dashboard, sell, products, stock, watch, sales, reports, settings };
    // A fresh container each render so view-level event listeners never pile up.
    const fresh = document.createElement('main');
    fresh.id = 'view';
    $('#view').replaceWith(fresh);
    (views[view] || dashboard)(fresh);
  }

  // =========================================================
  // Dashboard
  // =========================================================

  function dashboard(el) {
    const r = C.salesReport(state, { from: today(), to: today() });
    const s = C.stockSummary(state);
    const recent = state.sales.slice(-8).reverse();
    const rs = C.restockList(state);
    const ex = C.expiryReport(state);
    const wo = C.writeOffReport(state, { from: daysAgo(6), to: today() });
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Tonight at a glance</h1><p class="lead">${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p></div>
        <div class="row no-print"><button class="btn primary" data-go="sell">New sale</button><button class="btn" data-go="stock">Stock take</button></div>
      </div>
      <div class="grid kpis">
        ${kpi("Today's sales", money(r.revenue), plural(r.transactions, 'transaction'))}
        ${kpi('Gross profit', money(r.profit), r.margin + '% margin')}
        ${kpi('Items sold', r.units, 'Avg sale ' + money(r.averageSale))}
        ${kpi('Stock on hand', money(s.costValue), s.units + ' units · retail ' + money(s.retailValue))}
      </div>
      <div class="grid two">
        <div class="card">
          <div class="row" style="justify-content:space-between;margin-bottom:10px"><h3 style="margin:0">Stock watch</h3><button class="btn small no-print" data-go="watch">Open</button></div>
          <div class="watch-mini">
            <button data-watch="restock"><b class="${rs.rows.length ? 'warn-t' : ''}">${rs.rows.length}</b><span>to restock</span></button>
            <button data-watch="expiry"><b class="${ex.expired.length ? 'neg' : ex.rows.length ? 'warn-t' : ''}">${ex.rows.length}</b><span>expiring${ex.expired.length ? ` (${ex.expired.length} expired)` : ''}</span></button>
            <button data-watch="damaged"><b>${money(wo.value)}</b><span>damaged this week</span></button>
          </div>
          ${rs.rows.length ? `<div class="table-wrap"><table><thead><tr><th>Needs stock</th><th class="num">In stock</th><th class="num">Order</th><th></th></tr></thead><tbody>
            ${rs.rows.slice(0, 6).map((r) => `<tr><td>${esc(r.product.name)}</td><td class="num">${r.product.stock}</td><td class="num">${r.orderQty}</td><td>${restockPill(r)}</td></tr>`).join('')}
          </tbody></table></div>` : '<p class="empty">Nothing needs restocking.</p>'}
        </div>
        <div class="card">
          <h3>Top sellers today</h3>
          ${barChart(r.products.slice(0, 6).map((p) => [p.name, p.revenue, p.qty + ' × ']), true) || '<p class="empty">No sales yet today.</p>'}
        </div>
        <div class="card" style="grid-column: 1 / -1">
          <h3>Latest sales</h3>
          ${salesTable(recent) || '<p class="empty">No sales recorded yet. Head to <b>Sell</b> to ring one up.</p>'}
        </div>
      </div>`;
    $$('[data-go]', el).forEach((b) => b.addEventListener('click', () => { view = b.dataset.go; render(); }));
    $$('[data-watch]', el).forEach((b) => b.addEventListener('click', () => { view = 'watch'; watchTab = b.dataset.watch; render(); }));
    bindSaleButtons(el);
  }

  function kpi(label, value, hint) {
    return `<div class="card kpi"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="hint">${esc(hint)}</div></div>`;
  }

  function barChart(rows, asMoney = true) {
    if (!rows.length) return '';
    const max = Math.max(...rows.map((r) => r[1]), 0.01);
    return `<div class="bars">${rows.map(([label, v, prefix = '']) => `
      <div class="bar-row"><span class="lbl" title="${esc(label)}">${esc(label)}</span>
        <div class="track"><div class="fill" style="width:${(v / max) * 100}%"></div></div>
        <span class="amt">${esc(prefix)}${asMoney ? money(v) : v}</span></div>`).join('')}</div>`;
  }

  // =========================================================
  // Sell (point of sale)
  // =========================================================

  const cart = new Map(); // productId -> qty
  let sellCategory = 'All';
  let sellSearch = '';
  let payment = 'Cash';

  function sell(el) {
    const prods = activeProducts();
    const cats = ['All', ...new Set(prods.map((p) => p.category))];
    const shown = prods.filter((p) => (sellCategory === 'All' || p.category === sellCategory) && p.name.toLowerCase().includes(sellSearch.toLowerCase()));
    for (const id of cart.keys()) if (!prods.some((p) => p.id === id)) cart.delete(id);
    const lines = [...cart].map(([id, qty]) => ({ p: prods.find((x) => x.id === id), qty }));
    const total = C.round2(lines.reduce((s, l) => s + l.p.sellPrice * l.qty, 0));

    el.innerHTML = `
      <div class="sell">
        <section>
          <div class="row" style="margin-bottom:10px">
            <input id="sellSearch" type="search" placeholder="Search drinks…" value="${esc(sellSearch)}" style="flex:1">
          </div>
          <div class="cat-bar">${cats.map((c) => `<button data-cat="${esc(c)}" class="${c === sellCategory ? 'active' : ''}">${esc(c)}</button>`).join('')}</div>
          ${prods.length === 0 ? '<div class="card empty">No products yet. Add them under <b>Products</b>, or load sample data in <b>Settings</b>.</div>' : ''}
          <div class="tiles">
            ${shown.map((p) => {
              const left = p.stock - (cart.get(p.id) || 0);
              return `<button class="tile" data-add="${p.id}" ${left <= 0 ? 'disabled' : ''}>
                <span class="t-name">${esc(p.name)}</span>
                <span class="muted" style="font-size:12px">${esc(p.category)}</span>
                <span class="t-meta"><span class="t-price">${money(p.sellPrice)}</span><span>${left} left</span></span>
              </button>`;
            }).join('')}
          </div>
        </section>
        <aside class="card cart">
          <h2>Current order</h2>
          <div class="cart-lines">
            ${lines.length ? lines.map(({ p, qty }) => `
              <div class="cart-line">
                <div><div>${esc(p.name)}</div><div class="muted" style="font-size:12px">${money(p.sellPrice)} each</div></div>
                <div class="qty"><button data-dec="${p.id}" aria-label="Less">−</button><span>${qty}</span><button data-inc="${p.id}" aria-label="More" ${qty >= p.stock ? 'disabled' : ''}>+</button></div>
                <div class="num" style="min-width:80px;text-align:right">${money(p.sellPrice * qty)}</div>
              </div>`).join('') : '<p class="muted">Tap a drink to add it.</p>'}
          </div>
          <div class="cart-total"><span>Total</span><span>${money(total)}</span></div>
          <div class="pay">${C.PAYMENT_METHODS.map((m) => `<button data-pay="${m}" class="${m === payment ? 'active' : ''}">${m}</button>`).join('')}</div>
          <button class="btn primary charge" id="charge" ${lines.length ? '' : 'disabled'}>Record sale · ${money(total)}</button>
          ${lines.length ? '<button class="btn ghost" id="clearCart" style="width:100%;margin-top:8px">Clear order</button>' : ''}
        </aside>
      </div>`;

    const search = $('#sellSearch', el);
    search.addEventListener('input', () => {
      sellSearch = search.value;
      const pos = search.selectionStart;
      render();
      const s2 = $('#sellSearch');
      s2.focus();
      s2.setSelectionRange(pos, pos);
    });
    el.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.cat) { sellCategory = t.dataset.cat; render(); }
      else if (t.dataset.add || t.dataset.inc) { const id = t.dataset.add || t.dataset.inc; cart.set(id, (cart.get(id) || 0) + 1); render(); }
      else if (t.dataset.dec) { const q = cart.get(t.dataset.dec) - 1; q > 0 ? cart.set(t.dataset.dec, q) : cart.delete(t.dataset.dec); render(); }
      else if (t.dataset.pay) { payment = t.dataset.pay; render(); }
      else if (t.id === 'clearCart') { cart.clear(); render(); }
      else if (t.id === 'charge') {
        const sale = act(() => C.recordSale(state, { items: [...cart].map(([productId, qty]) => ({ productId, qty })), payment, staff: currentStaff() }),
          (s) => `Sale ${s.id} recorded · ${money(s.total)} (${s.payment})`);
        if (sale) { cart.clear(); render(); }
      }
    });
  }

  // =========================================================
  // Products
  // =========================================================

  let showArchived = false;
  let productSearch = '';

  function products(el) {
    const list = state.products
      .filter((p) => (showArchived || p.active) && (p.name + ' ' + p.category).toLowerCase().includes(productSearch.toLowerCase()))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Products</h1><p class="lead">Your price list. Stock levels change through sales, deliveries and stock takes.</p></div>
        <div class="row no-print">
          <input type="search" id="prodSearch" placeholder="Search…" value="${esc(productSearch)}">
          <label class="row muted" style="font-size:13px"><input type="checkbox" id="showArchived" ${showArchived ? 'checked' : ''}> Show archived</label>
          <button class="btn" id="exportProducts">Export CSV</button>
          <button class="btn primary" id="addProduct">Add product</button>
        </div>
      </div>
      <div class="card table-wrap">
        ${list.length ? `<table>
          <thead><tr><th>Product</th><th>Category</th><th>Unit</th><th class="num">Cost</th><th class="num">Price</th><th class="num">Margin</th><th class="num">Stock</th><th class="num">Reorder</th><th>Status</th><th></th></tr></thead>
          <tbody>${list.map((p) => {
            const margin = p.sellPrice > 0 ? Math.round(((p.sellPrice - p.costPrice) / p.sellPrice) * 100) : 0;
            return `<tr class="${p.active ? '' : 'dim'}">
              <td><b>${esc(p.name)}</b></td><td>${esc(p.category)}</td><td>${esc(p.unit)}</td>
              <td class="num">${money(p.costPrice)}</td><td class="num">${money(p.sellPrice)}</td>
              <td class="num ${margin < 0 ? 'neg' : ''}">${margin}%</td>
              <td class="num"><b>${p.stock}</b></td><td class="num">${p.reorderLevel}</td>
              <td>${p.active ? stockPill(p) : '<span class="pill">Archived</span>'}</td>
              <td class="num no-print" style="white-space:nowrap">
                ${p.active
                  ? `<button class="btn small" data-edit="${p.id}">Edit</button> <button class="btn small danger" data-del="${p.id}">Remove</button>`
                  : `<button class="btn small" data-restore="${p.id}">Restore</button>`}
              </td></tr>`;
          }).join('')}</tbody></table>`
          : '<p class="empty">No products found.</p>'}
      </div>`;

    const search = $('#prodSearch', el);
    search.addEventListener('input', () => { productSearch = search.value; render(); const s = $('#prodSearch'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); });
    $('#showArchived', el).addEventListener('change', (e) => { showArchived = e.target.checked; render(); });
    $('#addProduct', el).addEventListener('click', () => productForm());
    $('#exportProducts', el).addEventListener('click', () => {
      download('products-' + today() + '.csv', C.toCSV(
        ['Name', 'Category', 'Unit', 'Cost price', 'Selling price', 'Stock', 'Reorder level', 'Stock value (cost)', 'Active'],
        state.products.map((p) => [p.name, p.category, p.unit, p.costPrice, p.sellPrice, p.stock, p.reorderLevel, C.round2(p.stock * p.costPrice), p.active ? 'Yes' : 'No']),
      ));
    });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.edit) productForm(state.products.find((p) => p.id === b.dataset.edit));
      if (b.dataset.restore) act(() => C.updateProduct(state, b.dataset.restore, { active: true }), 'Product restored');
      if (b.dataset.del) {
        const p = state.products.find((x) => x.id === b.dataset.del);
        openModal({
          title: 'Remove ' + p.name + '?',
          body: '<p class="muted">Products with sales or stock history are archived so your reports stay accurate. You can restore them later.</p>',
          okText: 'Remove', danger: true,
          onSubmit: () => (C.deleteProduct(state, p.id) === 'archived' ? p.name + ' archived' : p.name + ' deleted'),
        });
      }
    });
  }

  function productForm(p) {
    const cats = [...new Set([...state.settings.categories, ...(p ? [p.category] : [])])];
    openModal({
      title: p ? 'Edit ' + p.name : 'Add product',
      body: `<div class="form-grid">
        <label class="field full">Name<input name="name" required value="${esc(p?.name)}" placeholder="e.g. Castle Lite 330ml"></label>
        <label class="field">Category<select name="category">${cats.map((c) => `<option ${c === p?.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label class="field">Unit<input name="unit" value="${esc(p?.unit || 'bottle')}" placeholder="bottle, can, tot, glass…"></label>
        <label class="field">Cost price (${esc(state.settings.currency)})<input name="costPrice" type="number" step="0.01" min="0" required value="${p?.costPrice ?? ''}"></label>
        <label class="field">Selling price (${esc(state.settings.currency)})<input name="sellPrice" type="number" step="0.01" min="0" required value="${p?.sellPrice ?? ''}"></label>
        ${p ? `<label class="field">Current stock<input value="${p.stock}" disabled></label>` : '<label class="field">Opening stock<input name="stock" type="number" step="1" min="0" value="0"></label>'}
        <label class="field">Reorder when at or below<input name="reorderLevel" type="number" step="1" min="0" value="${p?.reorderLevel ?? 6}"></label>
        <label class="field">Order up to (optional)<input name="parLevel" type="number" step="1" min="0" value="${p?.parLevel || ''}" placeholder="Auto"></label>
      </div>`,
      onSubmit: (f) => {
        const data = Object.fromEntries(f);
        if (p) { C.updateProduct(state, p.id, data); return 'Saved ' + data.name; }
        C.addProduct(state, data);
        return 'Added ' + data.name;
      },
    });
  }

  // =========================================================
  // Stock: stock take, deliveries, adjustments, movement log
  // =========================================================

  let stockTab = 'count';
  let countDraft = {}; // productId -> string typed so far, survives re-render
  let logFilter = '';

  function stock(el) {
    const tabs = [['count', 'Stock take'], ['receive', 'Deliveries'], ['log', 'Movement log'], ['history', 'Past counts']];
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Stock</h1><p class="lead">Count what is on the shelves, receive deliveries and see every movement.</p></div>
        <div class="row no-print">
          <button class="btn" id="damage">Record damage</button>
          <button class="btn" id="adjust">Adjust</button>
          <button class="btn primary" id="receive">Receive delivery</button>
        </div>
      </div>
      <div class="cat-bar no-print">${tabs.map(([k, l]) => `<button data-stab="${k}" class="${k === stockTab ? 'active' : ''}">${l}</button>`).join('')}</div>
      <div id="stockBody"></div>`;
    $$('[data-stab]', el).forEach((b) => b.addEventListener('click', () => { stockTab = b.dataset.stab; render(); }));
    $('#receive', el).addEventListener('click', deliveryForm);
    $('#adjust', el).addEventListener('click', adjustForm);
    $('#damage', el).addEventListener('click', () => damageForm());
    const body = $('#stockBody', el);
    ({ count: stockCount, receive: deliveryList, log: movementLog, history: stockTakeHistory })[stockTab](body);
  }

  function stockCount(el) {
    const prods = activeProducts();
    if (!prods.length) { el.innerHTML = '<div class="card empty">Add products first.</div>'; return; }
    let cat = null;
    el.innerHTML = `
      <div class="card">
        <p class="muted" style="margin-top:0">Type the physical count for each item. Leave a box empty to skip it. Variance is counted minus expected — negative means stock is missing.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Product</th><th class="num">Expected</th><th class="num">Counted</th><th class="num">Variance</th><th class="num">Value</th></tr></thead>
          <tbody>${prods.map((p) => {
            const head = p.category !== cat ? `<tr><td colspan="5" class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;padding-top:16px">${esc((cat = p.category))}</td></tr>` : '';
            return head + `<tr data-row="${p.id}">
              <td>${esc(p.name)} <span class="muted">· ${esc(p.unit)}</span></td>
              <td class="num">${p.stock}</td>
              <td class="num"><input class="count-input" type="number" min="0" step="1" inputmode="numeric" data-count="${p.id}" value="${esc(countDraft[p.id] ?? '')}"></td>
              <td class="num" data-var="${p.id}"></td><td class="num" data-val="${p.id}"></td></tr>`;
          }).join('')}</tbody>
        </table></div>
        <div class="row" style="justify-content:space-between;margin-top:14px">
          <div><span class="muted">Counted items:</span> <b id="countN">0</b> · <span class="muted">Net variance:</span> <b id="countTotal">${money(0)}</b></div>
          <div class="row">
            <input id="countNote" placeholder="Note (e.g. Friday close)" style="min-width:220px">
            <button class="btn ghost" id="countClear">Clear</button>
            <button class="btn ghost" id="countFill">Fill blanks with expected</button>
            <button class="btn primary" id="countSave">Save stock take</button>
          </div>
        </div>
      </div>`;

    const update = () => {
      let total = 0;
      let n = 0;
      for (const p of prods) {
        const raw = countDraft[p.id];
        const v = $(`[data-var="${p.id}"]`, el);
        const val = $(`[data-val="${p.id}"]`, el);
        if (raw === undefined || raw === '') { v.textContent = ''; val.textContent = ''; continue; }
        const diff = Number(raw) - p.stock;
        const value = C.round2(diff * p.costPrice);
        n += 1;
        total += value;
        v.innerHTML = `<span class="${diff < 0 ? 'neg' : diff > 0 ? 'pos' : 'muted'}">${signed(diff)}</span>`;
        val.innerHTML = `<span class="${value < 0 ? 'neg' : value > 0 ? 'pos' : 'muted'}">${money(value)}</span>`;
      }
      $('#countN', el).textContent = n;
      $('#countTotal', el).innerHTML = `<span class="${total < 0 ? 'neg' : ''}">${money(total)}</span>`;
    };
    el.addEventListener('input', (e) => {
      if (e.target.dataset.count) { countDraft[e.target.dataset.count] = e.target.value; update(); }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.dataset.count) {
        e.preventDefault();
        const inputs = $$('[data-count]', el);
        const next = inputs[inputs.indexOf(e.target) + 1];
        if (next) next.focus();
      }
    });
    $('#countFill', el).addEventListener('click', () => {
      for (const p of prods) if (countDraft[p.id] === undefined || countDraft[p.id] === '') countDraft[p.id] = String(p.stock);
      render();
    });
    $('#countClear', el).addEventListener('click', () => { countDraft = {}; render(); });
    $('#countSave', el).addEventListener('click', () => {
      const counts = {};
      for (const [id, v] of Object.entries(countDraft)) if (v !== '' && prods.some((p) => p.id === id)) counts[id] = v;
      const take = act(() => C.recordStockTake(state, { counts, staff: currentStaff(), note: $('#countNote', el).value }),
        (t) => `Stock take ${t.id} saved · net variance ${money(t.totalVarianceValue)}`);
      if (take) { countDraft = {}; stockTab = 'history'; render(); }
    });
    update();
  }

  function stockTakeHistory(el) {
    const takes = state.stockTakes.slice().reverse();
    el.innerHTML = `<div class="card">${takes.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Ref</th><th>Date</th><th>By</th><th>Note</th><th class="num">Items</th><th class="num">Items short</th><th class="num">Net variance</th><th></th></tr></thead>
      <tbody>${takes.map((t) => `<tr>
        <td>${t.id}</td><td>${fmtDateTime(t.date)}</td><td>${esc(t.staff)}</td><td>${esc(t.note)}</td>
        <td class="num">${t.lines.length}</td><td class="num">${t.lines.filter((l) => l.variance < 0).length}</td>
        <td class="num ${t.totalVarianceValue < 0 ? 'neg' : ''}">${money(t.totalVarianceValue)}</td>
        <td class="num"><button class="btn small" data-take="${t.id}">View</button></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">No stock takes yet.</p>'}</div>`;
    el.addEventListener('click', (e) => {
      const id = e.target.closest('[data-take]')?.dataset.take;
      if (!id) return;
      const t = state.stockTakes.find((x) => x.id === id);
      openModal({
        title: `Stock take ${t.id} · ${fmtDateTime(t.date)}`,
        body: `<div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Expected</th><th class="num">Counted</th><th class="num">Var.</th><th class="num">Value</th></tr></thead><tbody>
          ${t.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="num">${l.expected}</td><td class="num">${l.counted}</td>
            <td class="num ${l.variance < 0 ? 'neg' : l.variance > 0 ? 'pos' : ''}">${signed(l.variance)}</td><td class="num">${money(l.varianceValue)}</td></tr>`).join('')}
          </tbody></table></div>`,
        okText: 'Download CSV',
        onSubmit: () => {
          download(`stocktake-${t.id}.csv`, C.toCSV(['Product', 'Expected', 'Counted', 'Variance', 'Variance value'], t.lines.map((l) => [l.name, l.expected, l.counted, l.variance, l.varianceValue])));
        },
      });
    });
  }

  function deliveryForm() {
    if (!activeProducts().length) { toast('Add products first', true); return; }
    const lineHtml = () => `<div class="row delivery-line" style="margin-bottom:8px">
      <select name="productId" style="flex:2;min-width:160px">${productOptions()}</select>
      <input name="qty" type="number" min="1" step="1" placeholder="Qty" style="width:80px" required>
      <input name="unitCost" type="number" min="0" step="0.01" placeholder="Unit cost" style="width:110px">
      <input name="expiry" type="date" title="Expiry / best-before date (optional)" style="width:150px">
      <button type="button" class="btn small ghost" data-rm aria-label="Remove line">✕</button></div>`;
    openModal({
      title: 'Receive delivery',
      body: `<div class="form-grid" style="margin-bottom:12px">
          <label class="field">Supplier<input name="supplier" placeholder="e.g. SAB, Distell, Makro"></label>
          <label class="field">Invoice #<input name="invoice"></label>
        </div>
        <p class="muted" style="font-size:13px;margin:0 0 8px">Leave unit cost blank to keep the current cost price. Add a best-before date for items that expire (wine, ciders, mixers, snacks) so Stock Watch can warn you.</p>
        <div id="dLines">${lineHtml()}</div>
        <button type="button" class="btn small" id="dAdd">+ Add line</button>`,
      okText: 'Receive stock',
      onOpen: (b) => {
        $('#dAdd', b).addEventListener('click', () => $('#dLines', b).insertAdjacentHTML('beforeend', lineHtml()));
        b.addEventListener('click', (e) => { if (e.target.dataset.rm !== undefined && $$('.delivery-line', b).length > 1) e.target.closest('.delivery-line').remove(); });
      },
      onSubmit: (f, b) => {
        const items = $$('.delivery-line', b).map((row) => ({
          productId: $('[name=productId]', row).value,
          qty: $('[name=qty]', row).value,
          unitCost: $('[name=unitCost]', row).value,
          expiry: $('[name=expiry]', row).value,
        }));
        const d = C.receiveStock(state, { items, supplier: f.get('supplier'), invoice: f.get('invoice'), staff: currentStaff() });
        return `Delivery ${d.id} received · ${d.lines.reduce((s, l) => s + l.qty, 0)} units, ${money(d.total)}`;
      },
    });
  }

  function deliveryList(el) {
    const list = state.deliveries.slice().reverse();
    el.innerHTML = `<div class="card">${list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Ref</th><th>Date</th><th>Supplier</th><th>Invoice</th><th>Items</th><th class="num">Units</th><th class="num">Cost</th></tr></thead>
      <tbody>${list.map((d) => `<tr><td>${d.id}</td><td>${fmtDateTime(d.date)}</td><td>${esc(d.supplier)}</td><td>${esc(d.invoice)}</td>
        <td>${d.lines.map((l) => esc(l.name) + ' × ' + l.qty).join(', ')}</td>
        <td class="num">${d.lines.reduce((s, l) => s + l.qty, 0)}</td><td class="num">${money(d.total)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">No deliveries recorded yet. Use <b>Receive delivery</b> when stock arrives.</p>'}</div>`;
  }

  function adjustForm() {
    if (!activeProducts().length) { toast('Add products first', true); return; }
    openModal({
      title: 'Adjust stock',
      body: `<div class="form-grid">
        <label class="field full">Product<select name="productId">${productOptions()}</select></label>
        <p class="muted full" style="margin:0;font-size:13px">For broken, spilled or expired stock use <b>Record damage</b> so it appears in Stock Watch.</p>
        <label class="field">Change (use − to remove)<input name="qty" type="number" step="1" required placeholder="-1"></label>
        <label class="field">Reason<select name="reason"><option>Staff drink</option><option>Complimentary</option><option>Correction</option><option>Found stock</option></select></label>
      </div>`,
      onSubmit: (f) => {
        const p = C.adjustStock(state, { productId: f.get('productId'), qty: f.get('qty'), reason: f.get('reason'), staff: currentStaff() });
        return `${p.name} adjusted · now ${p.stock}`;
      },
    });
  }

  function movementLog(el) {
    const typeLabel = { sale: 'Sale', void: 'Void', receive: 'Delivery', stocktake: 'Count variance', adjust: 'Adjustment', writeoff: 'Damaged / write-off', opening: 'Opening' };
    const list = state.movements.filter((m) => !logFilter || m.productId === logFilter).slice(-300).reverse();
    el.innerHTML = `<div class="card">
      <div class="row" style="margin-bottom:10px"><select id="logFilter"><option value="">All products</option>${productOptions(logFilter)}</select>
        <span class="muted" style="font-size:13px">Showing latest ${list.length}</span></div>
      ${list.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Product</th><th>Type</th><th class="num">Change</th><th class="num">Balance</th><th>Ref</th><th>Note</th></tr></thead>
        <tbody>${list.map((m) => `<tr><td>${fmtDateTime(m.date)}</td><td>${esc(m.productName)}</td><td>${typeLabel[m.type] || m.type}</td>
          <td class="num ${m.qty < 0 ? 'neg' : 'pos'}">${signed(m.qty)}</td><td class="num">${m.balance}</td><td>${esc(m.ref)}</td><td class="muted">${esc(m.note)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="empty">No stock movements yet.</p>'}
    </div>`;
    $('#logFilter', el).addEventListener('change', (e) => { logFilter = e.target.value; render(); });
  }

  // =========================================================
  // Stock Watch: restocking, damaged stock, expiry
  // =========================================================

  let watchTab = 'restock';
  let woFrom = daysAgo(29);
  let woTo = today();

  function restockPill(r) {
    if (r.status === 'out') return '<span class="pill bad">Out of stock</span>';
    if (r.status === 'low') return '<span class="pill warn">Below reorder</span>';
    return '<span class="pill">Runs out soon</span>';
  }

  function expiryPill(r) {
    if (r.status === 'expired') return '<span class="pill bad">Expired</span>';
    if (r.status === 'week') return '<span class="pill warn">This week</span>';
    return '<span class="pill">Soon</span>';
  }

  function daysText(n) {
    if (n < 0) return `Expired ${plural(-n, 'day')} ago`;
    if (n === 0) return 'Expires today';
    return `in ${plural(n, 'day')}`;
  }

  function watch(el) {
    const rs = C.restockList(state);
    const ex = C.expiryReport(state);
    const wo = C.writeOffReport(state, { from: woFrom, to: woTo });
    const tabs = [['restock', 'Needs restocking', rs.rows.length], ['damaged', 'Damaged stock', wo.list.length], ['expiry', 'Expiring soon', ex.rows.length]];
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Stock Watch</h1><p class="lead">What to order, what was damaged, and what is about to expire.</p></div>
        <div class="row no-print">
          <button class="btn" id="wExpiry">Add expiry date</button>
          <button class="btn primary" id="wDamage">Record damage</button>
        </div>
      </div>
      <div class="grid kpis">
        ${kpi('To restock', plural(rs.rows.length, 'item'), 'Order value ' + money(rs.orderValue))}
        ${kpi('Out of stock', rs.rows.filter((r) => r.status === 'out').length, 'items with none left')}
        ${kpi('Damaged', money(wo.value), wo.units + ' units · ' + (woFrom === daysAgo(29) && woTo === today() ? 'last 30 days' : woFrom + ' → ' + woTo))}
        ${kpi('Expiring', ex.units + ' units', money(ex.value) + ' · ' + (ex.expired.length ? ex.expired.length + ' already expired' : 'within ' + ex.withinDays + ' days'))}
      </div>
      <div class="cat-bar no-print">${tabs.map(([k, l, n]) => `<button data-wtab="${k}" class="${k === watchTab ? 'active' : ''}">${l} <span class="muted">${n}</span></button>`).join('')}</div>
      <div id="watchBody"></div>`;
    $$('[data-wtab]', el).forEach((b) => b.addEventListener('click', () => { watchTab = b.dataset.wtab; render(); }));
    $('#wDamage', el).addEventListener('click', () => damageForm());
    $('#wExpiry', el).addEventListener('click', () => expiryForm());
    const body = $('#watchBody', el);
    ({ restock: () => watchRestock(body, rs), damaged: () => watchDamaged(body, wo), expiry: () => watchExpiry(body, ex) })[watchTab]();
  }

  function watchRestock(el, rs) {
    el.innerHTML = `<div class="card">
      <p class="muted" style="margin-top:0">Listed when stock is at or below its reorder level, or when the last ${rs.lookbackDays} days of sales say it will run out within ${rs.coverDays} days.
        <b>Order</b> tops up to the product's “order up to” level (set it under Products), or to a week of sales if none is set.</p>
      ${rs.rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Product</th><th>Category</th><th class="num">In stock</th><th class="num">Reorder at</th><th class="num">Sells / day</th><th class="num">Lasts</th><th class="num">Order</th><th class="num">Order cost</th><th>Status</th></tr></thead>
        <tbody>${rs.rows.map((r) => `<tr>
          <td><b>${esc(r.product.name)}</b> <span class="muted">· ${esc(r.product.unit)}</span></td><td>${esc(r.product.category)}</td>
          <td class="num">${r.product.stock}</td><td class="num">${r.product.reorderLevel}</td>
          <td class="num">${r.perDay || '—'}</td><td class="num">${r.daysLeft === null ? '—' : plural(r.daysLeft, 'day')}</td>
          <td class="num"><b>${r.orderQty}</b></td><td class="num">${money(r.orderValue)}</td><td>${restockPill(r)}</td></tr>`).join('')}
          <tr><td colspan="7"><b>Total order</b></td><td class="num"><b>${money(rs.orderValue)}</b></td><td></td></tr>
        </tbody></table></div>
        <div class="row no-print" style="margin-top:12px"><button class="btn" id="rsExport">Download order list (CSV)</button><button class="btn" id="rsPrint">Print</button></div>`
        : '<p class="empty">Nothing needs restocking right now.</p>'}
    </div>`;
    if (!rs.rows.length) return;
    $('#rsPrint', el).addEventListener('click', () => window.print());
    $('#rsExport', el).addEventListener('click', () => download(`order-list-${today()}.csv`, C.toCSV(
      ['Product', 'Category', 'Unit', 'In stock', 'Reorder level', 'Sells per day', 'Order qty', 'Unit cost', 'Order cost', 'Status'],
      rs.rows.map((r) => [r.product.name, r.product.category, r.product.unit, r.product.stock, r.product.reorderLevel, r.perDay, r.orderQty, r.product.costPrice, r.orderValue,
        { out: 'Out of stock', low: 'Below reorder', soon: 'Runs out soon' }[r.status]]),
    )));
  }

  function watchDamaged(el, wo) {
    el.innerHTML = `<div class="grid two">
      <div class="card" style="grid-column:1/-1">
        <div class="row no-print" style="margin-bottom:12px">
          <input type="date" id="woFrom" value="${woFrom}"> <span class="muted">to</span> <input type="date" id="woTo" value="${woTo}">
          ${wo.list.length ? '<button class="btn" id="woExport">Export CSV</button>' : ''}
        </div>
        ${wo.list.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Ref</th><th>Date</th><th>Product</th><th class="num">Qty</th><th>Reason</th><th>Note</th><th>By</th><th class="num">Cost</th></tr></thead>
          <tbody>${wo.list.map((w) => `<tr><td>${w.id}</td><td>${fmtDateTime(w.date)}</td><td>${esc(w.name)}</td><td class="num">${w.qty}</td>
            <td><span class="pill ${w.reason === 'Expired' ? 'warn' : 'bad'}">${esc(w.reason)}</span></td><td class="muted">${esc(w.note)}</td><td>${esc(w.staff)}</td>
            <td class="num neg">${money(-w.value)}</td></tr>`).join('')}
            <tr><td colspan="3"><b>Total</b></td><td class="num"><b>${wo.units}</b></td><td colspan="3"></td><td class="num neg"><b>${money(-wo.value)}</b></td></tr>
          </tbody></table></div>` : '<p class="empty">No damaged stock recorded in this period. Use <b>Record damage</b> for broken, spilled or expired items.</p>'}
      </div>
      ${wo.list.length ? `<div class="card"><h3>By reason</h3>${barChart(Object.entries(wo.byReason).sort((a, b) => b[1] - a[1]))}</div>
        <div class="card"><h3>Most damaged products</h3>${barChart(Object.entries(wo.byProduct).sort((a, b) => b[1] - a[1]).slice(0, 8))}</div>` : ''}
    </div>`;
    $('#woFrom', el).addEventListener('change', (e) => { woFrom = e.target.value || daysAgo(29); render(); });
    $('#woTo', el).addEventListener('change', (e) => { woTo = e.target.value || today(); render(); });
    if (wo.list.length) {
      $('#woExport', el).addEventListener('click', () => download(`damaged-stock-${woFrom}_to_${woTo}.csv`, C.toCSV(
        ['Ref', 'Date', 'Product', 'Category', 'Qty', 'Reason', 'Note', 'Staff', 'Unit cost', 'Value'],
        wo.list.map((w) => [w.id, new Date(w.date).toLocaleString(), w.name, w.category, w.qty, w.reason, w.note, w.staff, w.unitCost, w.value]),
      )));
    }
  }

  function watchExpiry(el, ex) {
    el.innerHTML = `<div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:6px">
        <p class="muted" style="margin:0">Dated stock that has expired or expires within <b>${ex.withinDays} days</b> (change this in Settings).
          Quantities assume older stock is sold first, so they update automatically with sales, damage and stock takes.</p>
      </div>
      ${ex.rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Product</th><th>Best before</th><th>When</th><th class="num">Qty left</th><th class="num">Value</th><th>Status</th><th>Note</th><th></th></tr></thead>
        <tbody>${ex.rows.map((r) => `<tr>
          <td><b>${esc(r.product.name)}</b></td><td>${new Date(r.expiry + 'T00:00:00').toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</td>
          <td class="${r.daysLeft < 0 ? 'neg' : r.daysLeft <= 7 ? 'warn-t' : ''}">${daysText(r.daysLeft)}</td>
          <td class="num">${r.remaining}</td><td class="num">${money(r.value)}</td><td>${expiryPill(r)}</td><td class="muted">${esc(r.note)}</td>
          <td class="num no-print" style="white-space:nowrap">
            <button class="btn small danger" data-wo="${r.id}">Write off</button>
            <button class="btn small" data-clear="${r.id}" title="Remove this expiry date, e.g. when it was all sold">Clear</button>
          </td></tr>`).join('')}</tbody></table></div>`
        : '<p class="empty">Nothing is close to expiring. Add best-before dates when you receive deliveries, or with <b>Add expiry date</b>.</p>'}
    </div>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const row = ex.rows.find((r) => r.id === (b.dataset.wo || b.dataset.clear));
      if (!row) return;
      if (b.dataset.wo) damageForm({ productId: row.productId, qty: row.remaining, reason: 'Expired', note: 'Best before ' + row.expiry, batchId: row.id });
      if (b.dataset.clear) act(() => C.removeExpiryBatch(state, row.id), 'Expiry date cleared for ' + row.product.name);
    });
  }

  function damageForm(prefill = {}) {
    if (!activeProducts().length) { toast('Add products first', true); return; }
    const reason = prefill.reason || 'Broken';
    openModal({
      title: 'Record damaged stock',
      body: `<div class="form-grid">
        <label class="field full">Product<select name="productId">${productOptions(prefill.productId)}</select></label>
        <label class="field">Quantity<input name="qty" type="number" min="1" step="1" required value="${prefill.qty ?? ''}"></label>
        <label class="field">Reason<select name="reason">${C.WRITE_OFF_REASONS.map((r) => `<option ${r === reason ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
        <label class="field full">Note (optional)<input name="note" value="${esc(prefill.note || '')}" placeholder="e.g. Crate dropped in cold room"></label>
      </div>
      <p class="muted" style="font-size:13px;margin-bottom:0">This removes the items from stock and records their cost as a loss.</p>`,
      okText: 'Write off',
      danger: true,
      onSubmit: (f) => {
        const w = C.recordWriteOff(state, { productId: f.get('productId'), qty: f.get('qty'), reason: f.get('reason'), note: f.get('note'), staff: currentStaff() });
        // Writing off a whole expired batch clears its expiry record too.
        if (prefill.batchId && w.productId === prefill.productId && w.qty >= prefill.qty) {
          state.batches = state.batches.filter((b) => b.id !== prefill.batchId);
        }
        return `${w.qty} × ${w.name} written off · ${money(w.value)}`;
      },
    });
  }

  function expiryForm() {
    if (!activeProducts().length) { toast('Add products first', true); return; }
    openModal({
      title: 'Add expiry date',
      body: `<p class="muted" style="margin-top:0;font-size:13px">For stock already on the shelf. Deliveries can carry a best-before date directly. This does not change stock levels.</p>
        <div class="form-grid">
        <label class="field full">Product<select name="productId">${productOptions()}</select></label>
        <label class="field">Quantity<input name="qty" type="number" min="1" step="1" required></label>
        <label class="field">Best before<input name="expiry" type="date" required></label>
        <label class="field full">Note (optional)<input name="note" placeholder="e.g. Back fridge"></label>
      </div>`,
      onSubmit: (f) => {
        const b = C.addExpiryBatch(state, { productId: f.get('productId'), qty: f.get('qty'), expiry: f.get('expiry'), note: f.get('note') });
        return 'Expiry date saved for ' + state.products.find((p) => p.id === b.productId).name;
      },
    });
  }

  // =========================================================
  // Sales records
  // =========================================================

  let salesFrom = today();
  let salesTo = today();

  function salesTable(list, withDate = false) {
    if (!list.length) return '';
    return `<div class="table-wrap"><table>
      <thead><tr><th>Ref</th><th>${withDate ? 'Date' : 'Time'}</th><th>Staff</th><th>Items</th><th>Payment</th><th class="num">Total</th><th></th></tr></thead>
      <tbody>${list.map((s) => `<tr class="${s.voided ? 'dim' : ''}">
        <td>${s.id}</td><td>${withDate ? fmtDateTime(s.date) : fmtTime(s.date)}</td><td>${esc(s.staff)}</td>
        <td>${s.lines.map((l) => esc(l.name) + ' × ' + l.qty).join(', ')}</td>
        <td>${s.voided ? '<span class="pill bad">Void</span>' : esc(s.payment)}</td>
        <td class="num">${money(s.total)}</td>
        <td class="num no-print"><button class="btn small" data-sale="${s.id}">View</button></td></tr>`).join('')}</tbody></table></div>`;
  }

  function bindSaleButtons(el) {
    el.addEventListener('click', (e) => {
      const id = e.target.closest('[data-sale]')?.dataset.sale;
      if (!id) return;
      const s = state.sales.find((x) => x.id === id);
      openModal({
        title: `Sale ${s.id}`,
        body: `<p class="muted" style="margin-top:0">${fmtDateTime(s.date)} · ${esc(s.staff || 'Unassigned')} · ${esc(s.payment)}</p>
          <div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead><tbody>
          ${s.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="num">${l.qty}</td><td class="num">${money(l.unitPrice)}</td><td class="num">${money(l.lineTotal)}</td></tr>`).join('')}
          <tr><td colspan="3"><b>Total</b></td><td class="num"><b>${money(s.total)}</b></td></tr></tbody></table></div>
          ${s.voided ? `<p class="neg">Voided ${fmtDateTime(s.voidedAt)}: ${esc(s.voidReason)}</p>`
            : '<label class="field" style="margin-top:14px">To void this sale and return the stock, give a reason:<input name="reason" placeholder="e.g. Rang up wrong drink"></label>'}`,
        okText: s.voided ? 'Close' : 'Void sale',
        danger: !s.voided,
        onSubmit: (f) => {
          if (s.voided) return '';
          C.voidSale(state, s.id, f.get('reason'));
          return `Sale ${s.id} voided, stock returned`;
        },
      });
    });
  }

  function sales(el) {
    const list = state.sales.filter((s) => { const d = C.localDay(s.date); return d >= salesFrom && d <= salesTo; }).reverse();
    const r = C.salesReport(state, { from: salesFrom, to: salesTo });
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Sales records</h1><p class="lead">Every transaction, with voids kept for the audit trail.</p></div>
        <div class="row no-print">
          <input type="date" id="sFrom" value="${salesFrom}"> <span class="muted">to</span> <input type="date" id="sTo" value="${salesTo}">
          <button class="btn" id="sExport">Export CSV</button>
        </div>
      </div>
      <div class="grid kpis">
        ${kpi('Sales', money(r.revenue), plural(r.transactions, 'transaction'))}
        ${kpi('Voids', r.voids, 'excluded from totals')}
        ${Object.entries(r.byPayment).map(([k, v]) => kpi(k, money(v), '')).join('')}
      </div>
      <div class="card">${salesTable(list, salesFrom !== salesTo) || '<p class="empty">No sales in this period.</p>'}</div>`;
    $('#sFrom', el).addEventListener('change', (e) => { salesFrom = e.target.value || today(); render(); });
    $('#sTo', el).addEventListener('change', (e) => { salesTo = e.target.value || today(); render(); });
    $('#sExport', el).addEventListener('click', () => {
      const rows = [];
      for (const s of list.slice().reverse()) for (const l of s.lines) {
        rows.push([s.id, new Date(s.date).toLocaleString(), s.staff, s.payment, l.name, l.category, l.qty, l.unitPrice, l.lineTotal, l.lineCost, s.voided ? 'VOID' : '']);
      }
      download(`sales-${salesFrom}_to_${salesTo}.csv`, C.toCSV(['Sale', 'Date', 'Staff', 'Payment', 'Product', 'Category', 'Qty', 'Unit price', 'Line total', 'Line cost', 'Status'], rows));
    });
    bindSaleButtons(el);
  }

  // =========================================================
  // Reports
  // =========================================================

  let repFrom = daysAgo(6);
  let repTo = today();

  function reports(el) {
    const r = C.salesReport(state, { from: repFrom, to: repTo });
    const takes = state.stockTakes.filter((t) => { const d = C.localDay(t.date); return d >= repFrom && d <= repTo; });
    const shrink = C.round2(takes.reduce((s, t) => s + t.totalVarianceValue, 0));
    const damaged = C.writeOffReport(state, { from: repFrom, to: repTo });
    const presets = [['Today', today(), today()], ['Yesterday', daysAgo(1), daysAgo(1)], ['Last 7 days', daysAgo(6), today()], ['Last 30 days', daysAgo(29), today()]];
    const maxHour = Math.max(...r.byHour, 0.01);
    const cats = {};
    for (const p of r.products) cats[p.category] = C.round2((cats[p.category] || 0) + p.revenue);

    el.innerHTML = `
      <div class="page-head">
        <div><h1>Reports</h1><p class="lead">${repFrom === repTo ? repFrom : repFrom + ' → ' + repTo}</p></div>
        <div class="row no-print">
          ${presets.map(([l, f, t]) => `<button class="btn small ${f === repFrom && t === repTo ? 'primary' : ''}" data-from="${f}" data-to="${t}">${l}</button>`).join('')}
          <input type="date" id="rFrom" value="${repFrom}"><input type="date" id="rTo" value="${repTo}">
          <button class="btn" id="rExport">Export CSV</button><button class="btn" id="rPrint">Print</button>
        </div>
      </div>
      <div class="grid kpis">
        ${kpi('Revenue', money(r.revenue), plural(r.transactions, 'sale') + ' · ' + r.units + ' items')}
        ${kpi('Cost of sales', money(r.cost), '')}
        ${kpi('Gross profit', money(r.profit), r.margin + '% margin')}
        ${kpi('Average sale', money(r.averageSale), r.voids + ' voided')}
        ${kpi('Stock variance', money(shrink), plural(takes.length, 'stock take'))}
        ${kpi('Damaged stock', money(-damaged.value), damaged.units + ' units written off')}
      </div>
      <div class="grid two">
        <div class="card"><h3>By category</h3>${barChart(Object.entries(cats).sort((a, b) => b[1] - a[1])) || '<p class="empty">No data</p>'}</div>
        <div class="card"><h3>By payment</h3>${barChart(Object.entries(r.byPayment).sort((a, b) => b[1] - a[1])) || '<p class="empty">No data</p>'}</div>
        <div class="card"><h3>By staff</h3>${barChart(Object.entries(r.byStaff).sort((a, b) => b[1] - a[1])) || '<p class="empty">No data</p>'}</div>
        <div class="card"><h3>Sales by hour</h3>
          <div class="hours">${r.byHour.map((v, h) => `<div title="${h}:00 · ${money(v)}" style="height:${(v / maxHour) * 100}%"></div>`).join('')}</div>
          <div class="hours-axis">${r.byHour.map((_, h) => `<span>${h % 3 === 0 ? h : ''}</span>`).join('')}</div>
        </div>
        ${repFrom !== repTo ? `<div class="card" style="grid-column:1/-1"><h3>By day</h3>${barChart(Object.entries(r.byDay).sort()) || '<p class="empty">No data</p>'}</div>` : ''}
        <div class="card" style="grid-column:1/-1"><h3>Product performance</h3>
          ${r.products.length ? `<div class="table-wrap"><table><thead><tr><th>Product</th><th>Category</th><th class="num">Qty sold</th><th class="num">Revenue</th><th class="num">Cost</th><th class="num">Profit</th><th class="num">Share</th></tr></thead><tbody>
            ${r.products.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.category)}</td><td class="num">${p.qty}</td><td class="num">${money(p.revenue)}</td><td class="num">${money(p.cost)}</td>
              <td class="num">${money(p.profit)}</td><td class="num">${r.revenue ? Math.round((p.revenue / r.revenue) * 100) : 0}%</td></tr>`).join('')}
          </tbody></table></div>` : '<p class="empty">No sales in this period.</p>'}
        </div>
      </div>`;

    $$('[data-from]', el).forEach((b) => b.addEventListener('click', () => { repFrom = b.dataset.from; repTo = b.dataset.to; render(); }));
    $('#rFrom', el).addEventListener('change', (e) => { repFrom = e.target.value || today(); render(); });
    $('#rTo', el).addEventListener('change', (e) => { repTo = e.target.value || today(); render(); });
    $('#rPrint', el).addEventListener('click', () => window.print());
    $('#rExport', el).addEventListener('click', () => download(`report-${repFrom}_to_${repTo}.csv`, C.toCSV(
      ['Product', 'Category', 'Qty sold', 'Revenue', 'Cost', 'Profit'],
      [...r.products.map((p) => [p.name, p.category, p.qty, p.revenue, p.cost, p.profit]), ['TOTAL', '', r.units, r.revenue, r.cost, r.profit]],
    )));
  }

  // =========================================================
  // Settings
  // =========================================================

  function settings(el) {
    const st = state.settings;
    el.innerHTML = `
      <div class="page-head"><div><h1>Settings</h1><p class="lead">Data is saved in this browser. Export a backup regularly.</p></div></div>
      <div class="grid two">
        <form class="card" id="setForm">
          <h3>Bar details</h3>
          <div class="form-grid">
            <label class="field">Bar name<input name="barName" value="${esc(st.barName)}" required></label>
            <label class="field">Currency symbol<input name="currency" value="${esc(st.currency)}" required maxlength="4"></label>
            <label class="field">Warn about expiry (days ahead)<input name="expiryWarningDays" type="number" min="1" max="365" step="1" value="${st.expiryWarningDays}"></label>
            <label class="field full">Staff (one per line)<textarea name="staff" rows="5">${esc(st.staff.join('\n'))}</textarea></label>
            <label class="field full">Categories (one per line)<textarea name="categories" rows="6">${esc(st.categories.join('\n'))}</textarea></label>
          </div>
          <div class="row" style="margin-top:12px"><button class="btn primary">Save settings</button></div>
        </form>
        <div class="grid" style="align-content:start">
          <div class="card">
            <h3>Backup &amp; restore</h3>
            <p class="muted" style="margin-top:0">Download everything as a single file, or restore from one. Use this to move to another device.</p>
            <div class="row">
              <button class="btn primary" id="backup">Download backup</button>
              <label class="btn">Restore backup<input type="file" id="restore" accept="application/json,.json" hidden></label>
            </div>
          </div>
          <div class="card">
            <h3>Getting started</h3>
            <p class="muted" style="margin-top:0">Load a typical bar price list to try the system out.</p>
            <button class="btn" id="sample" ${state.products.length ? 'disabled title="Only available when there are no products"' : ''}>Load sample products</button>
          </div>
          <div class="card">
            <h3>Danger zone</h3>
            <p class="muted" style="margin-top:0">Erase all products, sales and stock records from this browser.</p>
            <button class="btn danger" id="reset">Erase all data</button>
          </div>
        </div>
      </div>`;

    $('#setForm', el).addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const lines = (v) => [...new Set(String(v).split('\n').map((s) => s.trim()).filter(Boolean))];
      act(() => {
        const staff = lines(f.get('staff'));
        const categories = lines(f.get('categories'));
        if (!staff.length) throw new Error('Add at least one staff member');
        if (!categories.length) throw new Error('Add at least one category');
        const expiryWarningDays = Number(f.get('expiryWarningDays'));
        if (!Number.isInteger(expiryWarningDays) || expiryWarningDays < 1) throw new Error('Expiry warning must be a whole number of days');
        Object.assign(state.settings, { barName: String(f.get('barName')).trim() || 'Black Diamond Bar', currency: String(f.get('currency')).trim() || 'R', staff, categories, expiryWarningDays });
      }, 'Settings saved');
    });
    $('#backup', el).addEventListener('click', () => download(`black-diamond-backup-${today()}.json`, JSON.stringify(state, null, 2), 'application/json'));
    $('#restore', el).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const next = C.loadState(await file.text());
        openModal({
          title: 'Restore backup?',
          body: `<p>This replaces everything in this browser with the backup: <b>${next.products.length}</b> products, <b>${next.sales.length}</b> sales, <b>${next.stockTakes.length}</b> stock takes.</p>`,
          okText: 'Replace my data', danger: true,
          onSubmit: () => { state = next; return 'Backup restored'; },
        });
      } catch (err) {
        toast(err.message, true);
      }
      e.target.value = '';
    });
    $('#sample', el).addEventListener('click', () => act(loadSample, 'Sample products loaded'));
    $('#reset', el).addEventListener('click', () => openModal({
      title: 'Erase all data?',
      body: '<p>This cannot be undone. Download a backup first if you might need it.</p><label class="field">Type <b>ERASE</b> to confirm<input name="confirm" autocomplete="off"></label>',
      okText: 'Erase everything', danger: true,
      onSubmit: (f) => {
        if (f.get('confirm') !== 'ERASE') throw new Error('Type ERASE to confirm');
        state = C.createState();
        cart.clear();
        countDraft = {};
        return 'All data erased';
      },
    }));
  }

  function loadSample() {
    const items = [
      ['Castle Lager 340ml', 'Beer', 'bottle', 13.5, 28, 72, 24],
      ['Castle Lite 330ml', 'Beer', 'bottle', 14, 30, 96, 24],
      ['Black Label 340ml', 'Beer', 'bottle', 13.5, 28, 72, 24],
      ['Heineken 330ml', 'Beer', 'bottle', 17, 35, 48, 24],
      ['Corona 355ml', 'Beer', 'bottle', 20, 42, 24, 12],
      ['Savanna Dry 330ml', 'Cider', 'bottle', 17.5, 35, 48, 24],
      ['Hunters Dry 330ml', 'Cider', 'bottle', 16, 32, 36, 12],
      ['Jameson (tot)', 'Spirits', 'tot', 9.5, 30, 66, 20],
      ['Johnnie Walker Black (tot)', 'Spirits', 'tot', 14, 45, 44, 20],
      ['Hennessy VS (tot)', 'Spirits', 'tot', 18, 55, 40, 20],
      ['Smirnoff 1818 (tot)', 'Spirits', 'tot', 5, 20, 66, 20],
      ['Jägermeister (shot)', 'Shooters', 'shot', 9, 30, 50, 15],
      ['Tequila Gold (shot)', 'Shooters', 'shot', 7, 25, 50, 15],
      ['House Red (glass)', 'Wine', 'glass', 12, 45, 30, 10],
      ['House White (glass)', 'Wine', 'glass', 12, 45, 30, 10],
      ['Coca-Cola 300ml', 'Soft Drinks', 'can', 8, 20, 48, 24],
      ['Red Bull 250ml', 'Soft Drinks', 'can', 18, 40, 24, 12],
      ['Still Water 500ml', 'Soft Drinks', 'bottle', 6, 18, 24, 12],
      ['Peanuts', 'Snacks', 'packet', 7, 18, 20, 6],
    ];
    const ids = {};
    for (const [name, category, unit, costPrice, sellPrice, stock, reorderLevel] of items) {
      ids[name] = C.addProduct(state, { name, category, unit, costPrice, sellPrice, stock, reorderLevel }).id;
    }
    const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return C.localDay(d); };
    C.addExpiryBatch(state, { productId: ids['Peanuts'], qty: 6, expiry: inDays(-2), note: 'Sample' });
    C.addExpiryBatch(state, { productId: ids['House Red (glass)'], qty: 10, expiry: inDays(5), note: 'Open bottles' });
    C.addExpiryBatch(state, { productId: ids['Savanna Dry 330ml'], qty: 24, expiry: inDays(21), note: 'Sample' });
    C.addExpiryBatch(state, { productId: ids['Savanna Dry 330ml'], qty: 24, expiry: inDays(160), note: 'Sample' });
    C.recordWriteOff(state, { productId: ids['Castle Lager 340ml'], qty: 2, reason: 'Broken', note: 'Dropped behind bar', staff: currentStaff() });
  }

  // Re-read storage if another tab changes it, so two tills don't overwrite each other blindly.
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) { state = load(); render(); }
  });

  render();
})();
