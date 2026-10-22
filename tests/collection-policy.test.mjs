import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyState, recordEvent, getDaySummary, getHistory,
  getOperationalDate, getCollectionStatus,
} from '../dist/pilot-model.mjs';

const day = '2026-10-21';
const fresh = () => createEmptyState({code:'POLICY-TEST', name:'Datos ficticios', site:'Sede ficticia',
  initialBirds:100, startDate:day, formula:'Ficticia', openingFeedBags:5});
const add = (s, type, payload, extra={}) => recordEvent(s, {
  type, lotId:s.selectedLotId, businessDate:day, payload, ...extra,
});
const summary = s => getDaySummary(s, s.selectedLotId, day);
const status = (s, now) => getCollectionStatus(s, s.selectedLotId, day, new Date(now));
const completeReports = (s, eggs) => add(add(add(s, 'classification', {
  quantities:{AA:eggs}, dirty:0, lost:0,
}), 'supply', {bags:0}), 'mortality', {quantity:0});

test('Colombia date changes at 05:00 UTC, independently of device timezone', () => {
  assert.equal(getOperationalDate(new Date('2026-10-22T04:59:59.999Z')), '2026-10-21');
  assert.equal(getOperationalDate(new Date('2026-10-22T05:00:00.000Z')), '2026-10-22');
  assert.equal(getOperationalDate(new Date('2027-01-01T04:59:59Z')), '2026-12-31');
  assert.throws(() => getOperationalDate(new Date('invalid')), /hora|fecha/i);
});

test('missing collection alerts only after the Colombian day ends, without a false zero posture', () => {
  const s=fresh();
  assert.equal(status(s, '2026-10-22T04:59:59.999Z').alert, false);
  assert.equal(status(s, '2026-10-22T05:00:00Z').alert, true);
  assert.equal(status(s, '2026-10-20T12:00:00Z').alert, false);
  assert.equal(summary(s).posturePct, null);
  const mortalityOnly=add(s, 'mortality', {quantity:0});
  assert.equal(getHistory(mortalityOnly, mortalityOnly.selectedLotId)[0].collected, null);
  assert.equal(getHistory(mortalityOnly, mortalityOnly.selectedLotId)[0].posturePct, null);
});

test('one explicit zero collection is information, not a missing report', () => {
  const s=add(fresh(), 'collection', {turn:1, quantity:0});
  const progress=status(s, '2026-10-22T05:00:00Z');
  assert.equal(progress.hasData, true);
  assert.equal(progress.recorded, 1);
  assert.equal(progress.expected, 3);
  assert.equal(progress.belowUsualFrequency, true);
  assert.equal(progress.alert, false);
  assert.equal(summary(s).posturePct, 0);
});

for (const count of [1,2,3]) {
  test(`${count} actual collection(s) can close the local reconciled day without invented events`, () => {
    let s=fresh();
    for(let turn=1; turn<=count; turn++) s=add(s, 'collection', {turn, quantity:10});
    const before=completeReports(s, count*10);
    const restored=JSON.parse(JSON.stringify(before));
    const closed=add(restored, 'close', {closedBy:'Revisor ficticio'});
    assert.equal(summary(closed).closed, true);
    assert.equal(summary(closed).collected, count*10);
    assert.equal(summary(closed).collections.length, count);
    assert.equal(closed.events.filter(e=>e.type==='collection').length, count);
    assert.deepEqual(closed.events.slice(0,-1), before.events);
    assert.equal(closed.schemaVersion,1);
    assert.equal(summary(before).closed,false);
    assert.equal(status(closed, '2026-10-22T05:00:00Z').alert,false);
  });
}

test('zero collections cannot close, even with explicit empty classification and other reports', () => {
  const s=completeReports(fresh(), 0);
  assert.throws(() => add(s, 'close', {closedBy:'Revisor ficticio'}), /recogida/i);
  assert.equal(summary(s).closed,false);
  assert.equal(s.events.filter(e=>e.type==='collection').length,0);
});

test('fewer than three collections never bypass reconciliation, missing reports or duplicate controls', () => {
  const first=add(fresh(), 'collection', {turn:1, quantity:10});
  assert.throws(() => add(first, 'close', {closedBy:'Revisor ficticio'}), /clasificación/);
  const unmatched=completeReports(first,9);
  assert.throws(() => add(unmatched, 'close', {closedBy:'Revisor ficticio'}), /diferencia/);
  const noSupply=add(first,'classification',{quantities:{AA:10},dirty:0,lost:0});
  assert.throws(() => add(noSupply,'close',{closedBy:'Revisor ficticio'}), /suministro o mortalidad/);
  assert.throws(() => add(first,'collection',{turn:1,quantity:10}), /corrección/);
  assert.throws(() => add(first,'collection',{turn:4,quantity:10}), /turno/);
});

test('correction replaces collection quantity without adding frequency or losing originals', () => {
  const first=add(fresh(),'collection',{turn:1,quantity:10},{id:'original'});
  const corrected=add(first,'collection',{turn:1,quantity:12}, {
    supersedes:'original',reason:'Reconteo ficticio',id:'corrected',
  });
  assert.equal(summary(corrected).collections.length,1);
  assert.equal(summary(corrected).collected,12);
  assert.equal(corrected.events.length,2);
  assert.equal(first.events[0].payload.quantity,10);
});
