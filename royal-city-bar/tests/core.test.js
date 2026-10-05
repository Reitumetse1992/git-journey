const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');

function setup() {
  const s = core.createState();
  const castle = core.addProduct(s, { name: 'Castle Lager 340ml', category: 'Beer', costPrice: 12, sellPrice: 25, stock: 48, reorderLevel: 24 });
  const jameson = core.addProduct(s, { name: 'Jameson (tot)', category: 'Spirits', costPrice: 9.5, sellPrice: 30, stock: 10, reorderLevel: 5 });
  return { s, castle, jameson };
}

test('adding a product logs opening stock and rejects duplicates', () => {
  const { s, castle } = setup();
  assert.equal(castle.stock, 48);
  assert.equal(s.movements[0].type, 'opening');
  assert.throws(() => core.addProduct(s, { name: 'castle lager 340ml' }), /already exists/);
  assert.throws(() => core.addProduct(s, { name: '' }), /required/);
});

test('recording a sale reduces stock and snapshots prices', () => {
  const { s, castle, jameson } = setup();
  const sale = core.recordSale(s, {
    items: [{ productId: castle.id, qty: 2 }, { productId: jameson.id, qty: 1 }, { productId: castle.id, qty: 1 }],
    payment: 'Cash',
    staff: 'Thabo',
  });
  assert.equal(sale.total, 105);
  assert.equal(sale.cost, 45.5);
  assert.equal(sale.lines.length, 2, 'duplicate lines are merged');
  assert.equal(castle.stock, 45);
  assert.equal(jameson.stock, 9);

  core.updateProduct(s, castle.id, { sellPrice: 30 });
  assert.equal(s.sales[0].lines[0].unitPrice, 25, 'old sale keeps old price');
});

test('a sale is refused when stock is short and nothing changes', () => {
  const { s, castle, jameson } = setup();
  assert.throws(
    () => core.recordSale(s, { items: [{ productId: castle.id, qty: 1 }, { productId: jameson.id, qty: 11 }], payment: 'Card' }),
    /Not enough Jameson/,
  );
  assert.equal(castle.stock, 48);
  assert.equal(s.sales.length, 0);
  assert.throws(() => core.recordSale(s, { items: [{ productId: castle.id, qty: 1 }], payment: 'Bitcoin' }), /payment/);
});

test('voiding a sale returns stock and excludes it from reports', () => {
  const { s, castle } = setup();
  const sale = core.recordSale(s, { items: [{ productId: castle.id, qty: 6 }], payment: 'Card' });
  assert.throws(() => core.voidSale(s, sale.id, { reason: '', authorisedBy: 'Manager' }), /reason/);
  core.voidSale(s, sale.id, { reason: 'Rang up wrong item', voidedBy: 'Manager', authorisedBy: 'Manager' });
  assert.equal(castle.stock, 48);
  assert.throws(() => core.voidSale(s, sale.id, { reason: 'again', authorisedBy: 'Manager' }), /already voided/);
  const r = core.salesReport(s);
  assert.equal(r.revenue, 0);
  assert.equal(r.voids, 1);
});

test('receiving stock increases quantity and updates cost price', () => {
  const { s, castle } = setup();
  const d = core.receiveStock(s, { items: [{ productId: castle.id, qty: 24, unitCost: 13 }], supplier: 'SAB' });
  assert.equal(castle.stock, 72);
  assert.equal(castle.costPrice, 13);
  assert.equal(d.total, 312);
});

test('stock take sets counted stock and reports variance value', () => {
  const { s, castle, jameson } = setup();
  core.recordSale(s, { items: [{ productId: castle.id, qty: 8 }], payment: 'Cash' });
  const take = core.recordStockTake(s, { counts: { [castle.id]: 38, [jameson.id]: 10 } });
  const line = take.lines.find((l) => l.productId === castle.id);
  assert.equal(line.expected, 40);
  assert.equal(line.variance, -2);
  assert.equal(line.varianceValue, -24);
  assert.equal(castle.stock, 38);
  assert.equal(take.totalVarianceValue, -24);
  assert.equal(s.movements.filter((m) => m.type === 'stocktake').length, 1, 'zero variance not logged');
});

test('adjustments need a reason and cannot go negative', () => {
  const { s, jameson } = setup();
  assert.throws(() => core.adjustStock(s, { productId: jameson.id, qty: -1, reason: '' }), /reason/);
  assert.throws(() => core.adjustStock(s, { productId: jameson.id, qty: -11, reason: 'Broken' }), /negative/);
  core.adjustStock(s, { productId: jameson.id, qty: -1, reason: 'Spilled' });
  assert.equal(jameson.stock, 9);
});

test('sales report totals by product, payment, staff and date range', () => {
  const { s, castle, jameson } = setup();
  core.recordSale(s, { items: [{ productId: castle.id, qty: 4 }], payment: 'Cash', staff: 'Thabo', date: '2026-10-01T20:00:00' });
  core.recordSale(s, { items: [{ productId: jameson.id, qty: 2 }], payment: 'Card', staff: 'Lerato', date: '2026-10-02T21:00:00' });
  const all = core.salesReport(s);
  assert.equal(all.revenue, 160);
  assert.equal(all.cost, 67);
  assert.equal(all.profit, 93);
  assert.equal(all.units, 6);
  assert.deepEqual(all.byPayment, { Cash: 100, Card: 60 });
  assert.deepEqual(all.byStaff, { Thabo: 100, Lerato: 60 });
  assert.equal(all.products[0].name, 'Castle Lager 340ml');

  const day1 = core.salesReport(s, { from: '2026-10-01', to: '2026-10-01' });
  assert.equal(day1.revenue, 100);
  assert.equal(day1.transactions, 1);
});

test('stock summary flags low stock and values inventory', () => {
  const { s, castle } = setup();
  core.recordSale(s, { items: [{ productId: castle.id, qty: 30 }], payment: 'Cash' });
  const sum = core.stockSummary(s);
  assert.equal(sum.lowStock.length, 1);
  assert.equal(sum.lowStock[0].id, castle.id);
  assert.equal(sum.costValue, 18 * 12 + 10 * 9.5);
});

test('products with history are archived instead of deleted', () => {
  const { s, castle, jameson } = setup();
  core.recordSale(s, { items: [{ productId: castle.id, qty: 1 }], payment: 'Cash' });
  assert.equal(core.deleteProduct(s, castle.id), 'archived');
  assert.equal(castle.active, false);
  assert.equal(core.deleteProduct(s, jameson.id), 'deleted');
  assert.equal(s.products.length, 1);
});

test('backups round-trip and invalid files are rejected', () => {
  const { s } = setup();
  const restored = core.loadState(JSON.stringify(s));
  assert.equal(restored.products.length, 2);
  assert.throws(() => core.loadState('{"hello":1}'), /backup/);
});

test('CSV escapes commas and quotes', () => {
  assert.equal(core.toCSV(['a', 'b'], [['x,y', 'say "hi"']]), 'a,b\n"x,y","say ""hi"""');
});

test('write-offs remove stock, record value and refuse more than is on hand', () => {
  const { s, castle } = setup();
  assert.throws(() => core.recordWriteOff(s, { productId: castle.id, qty: 2, reason: 'Because' }), /reason/);
  assert.throws(() => core.recordWriteOff(s, { productId: castle.id, qty: 49, reason: 'Broken' }), /only 48/);
  const w = core.recordWriteOff(s, { productId: castle.id, qty: 3, reason: 'Broken', note: 'Dropped crate', staff: 'Thabo' });
  assert.equal(castle.stock, 45);
  assert.equal(w.value, 36);
  assert.equal(s.movements.at(-1).type, 'writeoff');
  core.recordWriteOff(s, { productId: castle.id, qty: 1, reason: 'Spilled' });
  const r = core.writeOffReport(s);
  assert.equal(r.units, 4);
  assert.equal(r.value, 48);
  assert.deepEqual(r.byReason, { Broken: 36, Spilled: 12 });
});

test('deliveries with expiry dates create batches; expiry report flags them', () => {
  const s = core.createState();
  const cider = core.addProduct(s, { name: 'Savanna', costPrice: 17.5, sellPrice: 35 });
  core.receiveStock(s, { items: [{ productId: cider.id, qty: 24, expiry: '2026-10-10' }] });
  core.receiveStock(s, { items: [{ productId: cider.id, qty: 24, expiry: '2027-03-01' }] });
  assert.equal(s.batches.length, 2);
  assert.throws(() => core.receiveStock(s, { items: [{ productId: cider.id, qty: 1, expiry: 'soon' }] }), /valid date/);

  let r = core.expiryReport(s, { today: '2026-10-05', withinDays: 30 });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].remaining, 24);
  assert.equal(r.rows[0].daysLeft, 5);
  assert.equal(r.rows[0].status, 'week');
  assert.equal(r.value, 420);

  // Selling 30 uses the older batch first, leaving 18 of the new one and none of the old.
  core.recordSale(s, { items: [{ productId: cider.id, qty: 30 }], payment: 'Cash' });
  r = core.expiryReport(s, { today: '2026-10-05', withinDays: 30 });
  assert.equal(r.rows.length, 0);

  r = core.expiryReport(s, { today: '2027-03-05', withinDays: 30 });
  assert.equal(r.rows[0].status, 'expired');
  assert.equal(r.rows[0].remaining, 18);
});

test('manual expiry dates and partial use of the oldest batch', () => {
  const { s, jameson } = setup();
  const b = core.addExpiryBatch(s, { productId: jameson.id, qty: 4, expiry: '2026-10-20' });
  core.addExpiryBatch(s, { productId: jameson.id, qty: 4, expiry: '2026-12-31' });
  assert.equal(jameson.stock, 10, 'adding an expiry date does not change stock');
  core.recordWriteOff(s, { productId: jameson.id, qty: 4, reason: 'Expired' });
  const r = core.expiryReport(s, { today: '2026-10-05', withinDays: 30 });
  assert.equal(r.rows[0].remaining, 2, '6 left: 4 belong to the later batch, 2 to the earlier one');
  core.removeExpiryBatch(s, b.id);
  assert.equal(core.expiryReport(s, { today: '2026-10-05', withinDays: 30 }).rows.length, 0);
});

test('restock list covers low stock and fast sellers with suggested quantities', () => {
  const s = core.createState();
  const low = core.addProduct(s, { name: 'Corona', costPrice: 20, sellPrice: 42, stock: 10, reorderLevel: 12, parLevel: 48 });
  const fast = core.addProduct(s, { name: 'Castle Lite', costPrice: 14, sellPrice: 30, stock: 100, reorderLevel: 10 });
  const fine = core.addProduct(s, { name: 'Peanuts', costPrice: 7, sellPrice: 18, stock: 20, reorderLevel: 6 });
  const out = core.addProduct(s, { name: 'Red Bull', costPrice: 18, sellPrice: 40, stock: 0, reorderLevel: 6 });
  // Castle Lite sells 84 over 14 days = 6/day; 16 left is above its reorder level but lasts ~2 days.
  for (let d = 0; d < 14; d++) {
    const day = new Date(2026, 9, 5 - d, 20);
    core.recordSale(s, { items: [{ productId: fast.id, qty: 6 }], payment: 'Cash', date: day.toISOString() });
  }
  const r = core.restockList(s, { today: '2026-10-05' });
  const names = r.rows.map((x) => x.product.name);
  assert.deepEqual(names, ['Red Bull', 'Corona', 'Castle Lite']);
  assert.ok(!names.includes(fine.name));
  const corona = r.rows.find((x) => x.product.id === low.id);
  assert.equal(corona.orderQty, 38, 'tops up to par level');
  assert.equal(corona.orderValue, 760);
  const castle = r.rows.find((x) => x.product.id === fast.id);
  assert.equal(castle.status, 'soon');
  assert.equal(castle.perDay, 6);
  assert.equal(castle.daysLeft, 2);
  assert.equal(castle.orderQty, 42 - 16, 'no par level: tops up to a week of sales');
  assert.equal(r.rows.find((x) => x.product.id === out.id).orderQty, 12);
});

test('voids need an allowed manager and their PIN, and record who did what', () => {
  const { s, castle } = setup();
  s.settings.staff = ['Lerato', 'Thabo', 'Sipho'];
  s.settings.managers = ['Lerato'];
  s.settings.managerPins = { Lerato: '4321' };
  const sale = core.recordSale(s, { items: [{ productId: castle.id, qty: 2 }], payment: 'Cash', staff: 'Thabo' });
  const base = { reason: 'Wrong item rung up', voidedBy: 'Thabo' };
  assert.throws(() => core.voidSale(s, sale.id, base), /must authorise/);
  assert.throws(() => core.voidSale(s, sale.id, { ...base, authorisedBy: 'Sipho' }), /not allowed/);
  assert.throws(() => core.voidSale(s, sale.id, { ...base, authorisedBy: 'Lerato', pin: '0000' }), /Incorrect PIN/);
  assert.equal(castle.stock, 46, 'failed attempts change nothing');
  const v = core.voidSale(s, sale.id, { ...base, authorisedBy: 'Lerato', pin: '4321' });
  assert.equal(v.voidedBy, 'Thabo');
  assert.equal(v.authorisedBy, 'Lerato');
  assert.equal(castle.stock, 48);
  assert.match(s.movements.at(-1).note, /authorised by Lerato/);
});

test('with no managers set up, any staff member can authorise', () => {
  const { s } = setup();
  s.settings.staff = ['Thabo'];
  s.settings.managers = ['Someone who left'];
  assert.deepEqual(core.voidAuthorisers(s), ['Thabo']);
});

test('staff report shows sales and voids per person and a void log', () => {
  const { s, castle, jameson } = setup();
  s.settings.staff = ['Lerato', 'Thabo'];
  s.settings.managers = ['Lerato'];
  core.recordSale(s, { items: [{ productId: castle.id, qty: 2 }], payment: 'Cash', staff: 'Thabo', date: '2026-10-03T20:00:00' });
  const bad = core.recordSale(s, { items: [{ productId: jameson.id, qty: 1 }], payment: 'Card', staff: 'Thabo', date: '2026-10-03T21:00:00' });
  core.recordSale(s, { items: [{ productId: jameson.id, qty: 3 }], payment: 'Card', staff: 'Lerato', date: '2026-10-03T22:00:00' });
  const own = core.recordSale(s, { items: [{ productId: castle.id, qty: 1 }], payment: 'Cash', staff: 'Lerato', date: '2026-10-03T22:30:00' });
  core.voidSale(s, bad.id, { reason: 'Wrong quantity', voidedBy: 'Thabo', authorisedBy: 'Lerato', date: '2026-10-03T21:05:00' });
  core.voidSale(s, own.id, { reason: 'Duplicate sale', voidedBy: 'Lerato', authorisedBy: 'Lerato', date: '2026-10-04T00:10:00' });

  const r = core.staffReport(s, { from: '2026-10-03', to: '2026-10-04' });
  const thabo = r.rows.find((x) => x.name === 'Thabo');
  const lerato = r.rows.find((x) => x.name === 'Lerato');
  assert.deepEqual([thabo.sales, thabo.revenue, thabo.items, thabo.voidedSales, thabo.voidedValue, thabo.voidsRequested], [1, 50, 2, 1, 30, 1]);
  assert.deepEqual([lerato.sales, lerato.revenue, lerato.voidsAuthorised, lerato.voidsRequested], [1, 90, 2, 1]);
  assert.equal(r.voids.length, 2);
  assert.equal(r.voids[0].saleId, own.id, 'newest void first');
  assert.equal(r.voids[0].selfAuthorised, true);
  assert.equal(r.voids[1].madeBy, 'Thabo');
  assert.equal(r.voidValue, 55);

  // Voids are dated by when they happened, not when the sale was made.
  assert.equal(core.staffReport(s, { from: '2026-10-03', to: '2026-10-03' }).voids.length, 1);
});

test('old backups without managers get one so voids still work', () => {
  const old = core.createState();
  old.settings.staff = ['Thabo', 'Lerato'];
  delete old.settings.managers;
  assert.deepEqual(core.loadState(JSON.stringify(old)).settings.managers, ['Thabo']);
});
