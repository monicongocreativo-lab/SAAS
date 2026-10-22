import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoState, createEmptyState, recordEvent, getActiveEvents, getDaySummary, getStock, getHistory } from '../dist/pilot-model.mjs';

const config = { code: 'PILOTO-01', name: 'Lote nuevo', site: 'Sede', initialBirds: 100,
  startDate: '2026-10-01', formula: 'Alimento elegido', openingFeedBags: 5 };
const fresh = overrides => createEmptyState({ ...config, ...overrides });
const input = (state, type, payload, extras = {}) => ({ type, lotId: state.selectedLotId, businessDate: '2026-10-18', payload, ...extras });
const add = (state, type, payload, extras) => recordEvent(state, input(state, type, payload, extras));
const summary = state => getDaySummary(state, state.selectedLotId, '2026-10-18');
const classification = (AA = 0, dirty = 0, lost = 0) => ({ quantities: { AA }, dirty, lost });
const collected = () => [1, 2, 3].reduce((s, turn) => add(s, 'collection', { turn, quantity: 10 }), fresh());
const ready = () => add(add(add(collected(), 'classification', classification(27, 1, 2)), 'supply', { bags: 0 }), 'mortality', { quantity: 0 });

test('field state has one configured lot, no historical data and validates config', () => {
  const state = fresh();
  assert.equal(state.mode, 'field');
  assert.equal(state.events.length, 0);
  assert.equal(state.lots[0].company, 'Tamago');
  assert.equal(state.lots[0].code, 'PILOTO-01');
  for (const overrides of [{ initialBirds: 0 }, { initialBirds: 1.5 }, { initialBirds: NaN },
    { openingFeedBags: -1 }, { startDate: '2026-02-30' }, { code: '<script>' }, { name: '' }]) {
    assert.throws(() => fresh(overrides));
  }
});

test('demo has seven dates in UTC across a year boundary and today remains partial', () => {
  const state = createDemoState('2027-01-03');
  const history = getHistory(state, state.selectedLotId);
  assert.equal(state.mode, 'demo');
  assert.equal(history.length, 7);
  assert.equal(history[0].date, '2026-12-28');
  assert.equal(history.at(-1).date, '2027-01-03');
  const today = getDaySummary(state, state.selectedLotId, '2027-01-03');
  assert.deepEqual(today.collections.map(c => c.turn), [1, 2]);
  assert.equal(today.collected, 7500);
  assert.equal(today.processed, 7000);
  assert.equal(today.unclassified, 500);
  assert.equal(today.closed, false);
  assert.ok(getStock(state, state.selectedLotId, '2027-01-03').feedBags > 0);
  assert.throws(() => createDemoState('2026-02-29'));
});

test('recording and correction preserve original state, payload and complete audit history', () => {
  const start = fresh();
  const payload = { turn: 1, quantity: 10 };
  const first = add(start, 'collection', payload, { id: 'first' });
  assert.equal(start.events.length, 0);
  payload.quantity = 999;
  assert.equal(first.events[0].payload.quantity, 10);
  const corrected = add(first, 'collection', { turn: 1, quantity: 12 }, { id: 'second', supersedes: 'first', reason: 'Reconteo documentado' });
  assert.equal(first.events.length, 1);
  assert.equal(corrected.events.length, 2);
  assert.equal(corrected.events[0].payload.quantity, 10);
  assert.equal(corrected.events[1].reason, 'Reconteo documentado');
  assert.match(corrected.events[1].recordedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(getActiveEvents(corrected).map(e => e.id), ['second']);
  getActiveEvents(corrected)[0].payload.quantity = 1;
  assert.equal(summary(corrected).collected, 12);
  corrected.events[0].payload.quantity = 5;
  assert.equal(first.events[0].payload.quantity, 10);
});

test('duplicates require explicit correction and unique IDs', () => {
  const state = add(fresh(), 'collection', { turn: 1, quantity: 10 }, { id: 'one' });
  assert.throws(() => add(state, 'collection', { turn: 1, quantity: 11 }), /corrección/);
  assert.throws(() => add(state, 'collection', { turn: 2, quantity: 11 }, { id: 'one' }), /identificador/);
  assert.throws(() => add(state, 'collection', { turn: 1, quantity: 11 }, { supersedes: 'one' }), /Motivo/);
  assert.throws(() => add(state, 'collection', { turn: 2, quantity: 11 }, { supersedes: 'one', reason: 'Cambio' }), /turno/);
  assert.throws(() => add(state, 'collection', { turn: 1, quantity: 11 }, { supersedes: 'one', reason: 'Cambio', businessDate: '2026-10-17' }), /fecha/);
  const changed = add(state, 'collection', { turn: 1, quantity: 11 }, { supersedes: 'one', reason: 'Cambio' });
  assert.throws(() => add(changed, 'collection', { turn: 1, quantity: 12 }, { supersedes: 'one', reason: 'Otra' }), /sustituido/);
});

test('missing reports remain null, explicit zeros remain confirmed', () => {
  const state = fresh();
  assert.equal(summary(state).mortality, null);
  assert.equal(summary(state).feedSuppliedBags, null);
  assert.equal(summary(state).gramsPerBird, null);
  const explicit = add(add(state, 'mortality', { quantity: 0 }), 'supply', { bags: 0 });
  assert.equal(summary(explicit).mortality, 0);
  assert.equal(summary(explicit).feedSuppliedKg, 0);
  assert.equal(summary(explicit).gramsPerBird, 0);
});

test('classification separates losses, dirty and sellable quantities, no automatic balancing', () => {
  const state = add(collected(), 'classification', classification(20, 3, 2));
  const day = summary(state);
  assert.equal(day.classifiedForSale, 20);
  assert.equal(day.processed, 25);
  assert.equal(day.difference, 5);
  assert.equal(day.lost, 2);
  const stock = getStock(state, state.selectedLotId, '2026-10-18');
  assert.deepEqual([stock.eggsTotal, stock.dirty, stock.unclassified], [20, 3, 5]);
  assert.throws(() => add(collected(), 'classification', classification(31)), /supera/);
  assert.throws(() => add(collected(), 'classification', { quantities: { YEMAS: 1 }, dirty: 0, lost: 0 }), /unidad/);
  assert.throws(() => add(state, 'collection', { turn: 1, quantity: 0 }, { supersedes: day.collections[0].id, reason: 'Reducir' }), /supera/);
});

test('feed stock uses receipts and supply once, accepts two decimals, prevents future deficits', () => {
  let state = add(fresh(), 'supply', { bags: 4.25 });
  assert.equal(getStock(state, state.selectedLotId, '2026-10-18').feedBags, 0.75);
  assert.equal(summary(state).feedSuppliedKg, 170);
  assert.equal(summary(state).gramsPerBird, 1700);
  assert.throws(() => add(fresh(), 'supply', { bags: 5.01 }), /disponible/);
  assert.throws(() => add(fresh(), 'supply', { bags: 0.001 }), /decimales/);
  assert.throws(() => add(fresh(), 'feed_receipt', { bags: 0, formula: 'F' }));
  state = add(state, 'feed_receipt', { bags: 2, formula: 'Otra' });
  assert.equal(getStock(state, state.selectedLotId, '2026-10-18').feedBags, 2.75);
  let future = add(fresh(), 'supply', { bags: 5 }, { businessDate: '2026-10-20' });
  assert.throws(() => add(future, 'supply', { bags: 1 }, { businessDate: '2026-10-19' }), /disponible/);
  const receipt = add(fresh({ openingFeedBags: 0 }), 'feed_receipt', { bags: 6, formula: 'F' }, { id: 'receipt' });
  const supplied = add(receipt, 'supply', { bags: 5 });
  assert.throws(() => add(supplied, 'feed_receipt', { bags: 4, formula: 'F' }, { supersedes: 'receipt', reason: 'Corregir' }), /disponible/);
});

test('correcting classification after dirty treatment changes categories without producing eggs twice', () => {
  const first = add(collected(), 'classification', classification(20, 8, 2), { id: 'class-1' });
  const corrected = add(first, 'classification', classification(28, 0, 2), { supersedes: 'class-1', reason: 'Tratamiento de ocho huevos sucios' });
  assert.equal(corrected.events.filter(e => e.type === 'classification').length, 2);
  assert.equal(getActiveEvents(corrected).filter(e => e.type === 'classification').length, 1);
  assert.equal(summary(corrected).collected, 30);
  assert.equal(summary(corrected).processed, 30);
  assert.equal(summary(corrected).difference, 0);
  const stock = getStock(corrected, corrected.selectedLotId, '2026-10-18');
  assert.equal(stock.eggsTotal, 28);
  assert.equal(stock.dirty, 0);
  assert.equal(stock.unclassified, 0);
});

test('mortality uses one active report and changes calculated birds, never duplicates alternatives', () => {
  const first = add(fresh(), 'mortality', { quantity: 2 }, { id: 'm' });
  assert.equal(summary(first).birds, 98);
  const corrected = add(first, 'mortality', { quantity: 3 }, { supersedes: 'm', reason: 'Cuaderno revisado' });
  assert.equal(summary(corrected).birds, 97);
  assert.throws(() => add(first, 'mortality', { quantity: 2 }), /corrección/);
  assert.throws(() => add(first, 'mortality', { quantity: 99 }, { businessDate: '2026-10-19' }), /aves disponibles/);
  const zero = add(fresh(), 'mortality', { quantity: 100 });
  assert.equal(summary(zero).posturePct, null);
  assert.equal(summary(zero).gramsPerBird, null);
});

test('local close requires complete reports and exact reconciliation, then blocks all modifications', () => {
  assert.throws(() => add(fresh(), 'close', { closedBy: 'David' }), /al menos una recogida/);
  assert.throws(() => add(collected(), 'close', { closedBy: 'David' }), /clasificación/);
  const partial = add(collected(), 'classification', classification(29));
  assert.throws(() => add(partial, 'close', { closedBy: 'David' }), /diferencia/);
  assert.throws(() => add(add(collected(), 'classification', classification(30)), 'close', { closedBy: 'David' }), /suministro o mortalidad/);
  const before = ready();
  const closed = add(before, 'close', { closedBy: 'David' });
  assert.equal(summary(closed).closed, true);
  assert.equal(summary(closed).closedBy, 'David');
  assert.equal(summary(before).closed, false);
  assert.throws(() => add(closed, 'feed_receipt', { bags: 1, formula: 'F' }), /cerrada/);
  assert.throws(() => add(closed, 'collection', { turn: 1, quantity: 11 }, { supersedes: summary(closed).collections[0].id, reason: 'Cambio' }), /cerrada/);
  assert.equal(Object.hasOwn(closed.events.at(-1), 'posted'), false);
  assert.equal(Object.hasOwn(closed.events.at(-1), 'sync'), false);
});

test('date, type, lot, quantities and unsafe keys are rejected before recording', () => {
  const state = fresh();
  for (const businessDate of ['2026-02-30', '18/10/2026', '2026-09-30', undefined]) {
    assert.throws(() => add(state, 'collection', { turn: 1, quantity: 1 }, { businessDate }));
    assert.throws(() => getDaySummary(state, state.selectedLotId, businessDate));
    assert.throws(() => getStock(state, state.selectedLotId, businessDate));
  }
  for (const q of [-1, 1.1, Infinity, NaN, '1']) assert.throws(() => add(state, 'collection', { turn: 1, quantity: q }));
  assert.throws(() => add(state, 'collection', { turn: 4, quantity: 1 }));
  assert.throws(() => add(state, 'unknown', {}));
  assert.throws(() => add(state, 'collection', { turn: 1, quantity: 1 }, { lotId: 'other' }));
  assert.throws(() => add(state, 'feed_receipt', { bags: 1, formula: '<img onerror=alert(1)>' }));
  assert.throws(() => add(state, 'classification', { quantities: JSON.parse('{"__proto__":1}'), dirty: 0, lost: 0 }));
  assert.throws(() => add(state, 'collection', { turn: 1, quantity: 1, unexpected: 1 }));
  assert.throws(() => add(state, 'collection', { turn: 1, quantity: 1 }, { id: '<script>' }));
  assert.equal(state.events.length, 0);
});

test('history has only event dates and day summary exposes the exact requested contract', () => {
  const state = add(add(fresh(), 'mortality', { quantity: 1 }, { businessDate: '2026-10-16' }), 'collection', { turn: 1, quantity: 20 });
  assert.deepEqual(getHistory(state, state.selectedLotId).map(x => x.date), ['2026-10-16', '2026-10-18']);
  assert.equal(summary(state).birds, 99);
  assert.equal(summary(state).posturePct, 20 / 99 * 100);
  assert.deepEqual(Object.keys(summary(state)), ['collections', 'collected', 'quantities', 'classifiedForSale', 'dirty', 'lost', 'processed',
    'unclassified', 'difference', 'classEventId', 'supplyEventId', 'mortalityEventId', 'feedSuppliedBags', 'feedSuppliedKg',
    'mortality', 'birds', 'posturePct', 'gramsPerBird', 'closed', 'closedBy']);
});
