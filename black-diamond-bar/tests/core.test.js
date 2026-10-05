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
  assert.throws(() => core.voidSale(s, sale.id, ''), /reason/);
  core.voidSale(s, sale.id, 'Rang up wrong item');
  assert.equal(castle.stock, 48);
  assert.throws(() => core.voidSale(s, sale.id, 'again'), /already voided/);
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
