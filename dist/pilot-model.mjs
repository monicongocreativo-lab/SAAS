/** Local prototype domain model. No persistence, network, accounting or sync. */
const CATEGORIES = ['YUMBO', 'EXTRA', 'AA', 'A', 'B', 'C', 'ROTOS', 'BLANCO', 'PIPO', 'YEMAS'];
const TYPES = ['collection', 'classification', 'supply', 'feed_receipt', 'mortality', 'close'];
const SINGLE = new Set(['classification', 'supply', 'mortality', 'close']);
const ERROR = message => { throw new Error(message); };
const round = value => Math.round((value + Number.EPSILON) * 1e10) / 1e10;
const clone = value => JSON.parse(JSON.stringify(value));

function cleanObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) ERROR(`${label}: objeto inválido.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) ERROR(`${label}: campo no permitido «${key}».`);
  }
}

function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[<>\u0000-\u001f]/u.test(value)) {
    ERROR(`${label}: escribe un texto válido sin etiquetas HTML.`);
  }
  return value.trim();
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) ERROR('Fecha inválida: utiliza AAAA-MM-DD.');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) ERROR('La fecha no existe en el calendario.');
  return value;
}

function quantity(value, label, { integer = false, positive = false, decimals = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && value === 0) ||
      (integer && !Number.isSafeInteger(value)) ||
      (decimals && Math.abs(value * 100 - Math.round(value * 100)) > 1e-7)) {
    ERROR(`${label}: cantidad inválida${integer ? ', debe ser un entero' : ''}${decimals ? ', máximo dos decimales' : ''}.`);
  }
  return value;
}

function lotFor(state, lotId, businessDate) {
  const lot = state.lots.find(item => item.id === lotId);
  if (!lot) ERROR('El lote no existe.');
  if (businessDate !== undefined) {
    validDate(businessDate);
    if (businessDate < lot.startDate) ERROR('La fecha es anterior al inicio registrado del lote.');
  }
  return lot;
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function validId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) ERROR('Identificador inválido.');
  return value;
}

export function createEmptyState(config) {
  cleanObject(config, ['code', 'name', 'site', 'initialBirds', 'startDate', 'formula', 'openingFeedBags'], 'Configuración');
  const code = text(config.code, 'Código', 32);
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(code)) ERROR('Código de lote inválido.');
  const lot = {
    id: makeId(), code, name: text(config.name, 'Nombre'), site: text(config.site, 'Sede'), company: 'Tamago',
    initialBirds: quantity(config.initialBirds, 'Aves iniciales', { integer: true, positive: true }),
    startDate: validDate(config.startDate), formula: text(config.formula, 'Fórmula'),
    openingFeedBags: quantity(config.openingFeedBags, 'Saldo inicial de alimento'),
  };
  return { schemaVersion: 1, mode: 'field', selectedLotId: lot.id, lots: [lot], events: [] };
}

/** Returned events are detached copies, so consumers cannot mutate the audit trail. */
export function getActiveEvents(state) {
  const replaced = new Set(state.events.filter(e => e.supersedes).map(e => e.supersedes));
  return state.events.filter(e => !replaced.has(e.id)).map(clone);
}

function emptyQuantities() {
  return Object.fromEntries(CATEGORIES.map(category => [category, 0]));
}

export function getDaySummary(state, lotId, businessDate) {
  validDate(businessDate);
  const lot = lotFor(state, lotId, businessDate);
  const active = getActiveEvents(state).filter(e => e.lotId === lotId);
  const day = active.filter(e => e.businessDate === businessDate);
  const collections = day.filter(e => e.type === 'collection')
    .map(e => ({ turn: e.payload.turn, quantity: e.payload.quantity, id: e.id })).sort((a, b) => a.turn - b.turn);
  const collected = collections.reduce((total, e) => total + e.quantity, 0);
  const classification = day.find(e => e.type === 'classification');
  const supply = day.find(e => e.type === 'supply');
  const mortality = day.find(e => e.type === 'mortality');
  const close = day.find(e => e.type === 'close');
  const quantities = { ...emptyQuantities(), ...(classification?.payload.quantities ?? {}) };
  const classifiedForSale = Object.values(quantities).reduce((a, b) => a + b, 0);
  const dirty = classification?.payload.dirty ?? 0;
  const lost = classification?.payload.lost ?? 0;
  const processed = classifiedForSale + dirty + lost;
  const difference = collected - processed;
  const birds = lot.initialBirds - active.filter(e => e.type === 'mortality' && e.businessDate <= businessDate)
    .reduce((sum, e) => sum + e.payload.quantity, 0);
  const feedSuppliedBags = supply ? supply.payload.bags : null;
  const feedSuppliedKg = supply ? round(feedSuppliedBags * 40) : null;
  return {
    collections, collected, quantities, classifiedForSale, dirty, lost, processed,
    unclassified: Math.max(0, difference), difference,
    classEventId: classification?.id ?? null, supplyEventId: supply?.id ?? null, mortalityEventId: mortality?.id ?? null,
    feedSuppliedBags, feedSuppliedKg, mortality: mortality?.payload.quantity ?? null, birds,
    posturePct: birds > 0 ? collected / birds * 100 : null,
    gramsPerBird: birds > 0 && feedSuppliedKg !== null ? feedSuppliedKg * 1000 / birds : null,
    closed: Boolean(close), closedBy: close?.payload.closedBy ?? null,
  };
}

export function getStock(state, lotId, businessDate) {
  validDate(businessDate);
  const lot = lotFor(state, lotId, businessDate);
  const active = getActiveEvents(state).filter(e => e.lotId === lotId && e.businessDate <= businessDate);
  const eggs = emptyQuantities();
  let feedBags = lot.openingFeedBags;
  let dirty = 0;
  let collected = 0;
  let processed = 0;
  for (const event of active) {
    const payload = event.payload;
    if (event.type === 'feed_receipt') feedBags += payload.bags;
    if (event.type === 'supply') feedBags -= payload.bags;
    if (event.type === 'collection') collected += payload.quantity;
    if (event.type === 'classification') {
      for (const category of CATEGORIES) eggs[category] += payload.quantities[category] ?? 0;
      dirty += payload.dirty;
      processed += Object.values(payload.quantities).reduce((a, b) => a + b, 0) + payload.dirty + payload.lost;
    }
  }
  return { feedBags: round(feedBags), eggsTotal: Object.values(eggs).reduce((a, b) => a + b, 0),
    eggs, dirty, unclassified: Math.max(0, collected - processed) };
}

export function getHistory(state, lotId) {
  lotFor(state, lotId);
  const dates = [...new Set(getActiveEvents(state).filter(e => e.lotId === lotId).map(e => e.businessDate))].sort();
  return dates.map(date => {
    const day = getDaySummary(state, lotId, date);
    return { date, collected: day.collected, classifiedForSale: day.classifiedForSale, dirty: day.dirty,
      lost: day.lost, feedSuppliedKg: day.feedSuppliedKg, birds: day.birds, posturePct: day.posturePct, closed: day.closed };
  });
}

function payloadFor(type, payload) {
  if (type === 'collection') {
    cleanObject(payload, ['turn', 'quantity'], 'Recogida');
    if (![1, 2, 3].includes(payload.turn)) ERROR('El turno debe ser 1, 2 o 3.');
    return { turn: payload.turn, quantity: quantity(payload.quantity, 'Huevos recogidos', { integer: true }) };
  }
  if (type === 'classification') {
    cleanObject(payload, ['quantities', 'dirty', 'lost'], 'Clasificación');
    cleanObject(payload.quantities, CATEGORIES, 'Tipologías');
    const quantities = emptyQuantities();
    for (const category of CATEGORIES) {
      if (Object.hasOwn(payload.quantities, category)) quantities[category] = quantity(payload.quantities[category], category, { integer: true });
    }
    if (quantities.YEMAS > 0) ERROR('YEMAS usa otra unidad: falta definir su equivalencia. Registra esta operación fuera de este primer piloto.');
    return { quantities, dirty: quantity(payload.dirty, 'Sucios', { integer: true }), lost: quantity(payload.lost, 'Descartes', { integer: true }) };
  }
  if (type === 'supply' || type === 'feed_receipt') {
    cleanObject(payload, type === 'supply' ? ['bags'] : ['bags', 'formula'], 'Alimento');
    const bags = quantity(payload.bags, 'Bultos de 40 kg', { positive: type === 'feed_receipt', decimals: true });
    return type === 'supply' ? { bags } : { bags, formula: text(payload.formula, 'Fórmula recibida') };
  }
  if (type === 'mortality') {
    cleanObject(payload, ['quantity'], 'Mortalidad');
    return { quantity: quantity(payload.quantity, 'Mortalidad', { integer: true }) };
  }
  cleanObject(payload, ['closedBy'], 'Cierre');
  return { closedBy: text(payload.closedBy, 'Responsable del cierre') };
}

/** Append-only correction history; superseding never edits or deletes the original. */
export function recordEvent(state, input) {
  cleanObject(input, ['type', 'lotId', 'businessDate', 'payload', 'id', 'supersedes', 'reason'], 'Registro');
  if (!TYPES.includes(input.type)) ERROR('Tipo de registro no admitido.');
  validDate(input.businessDate);
  lotFor(state, input.lotId, input.businessDate);
  const payload = payloadFor(input.type, input.payload);
  const active = getActiveEvents(state);
  const sameDay = active.filter(e => e.lotId === input.lotId && e.businessDate === input.businessDate);
  if (sameDay.some(e => e.type === 'close')) ERROR('La jornada está cerrada. Requiere reapertura, no disponible en este piloto.');
  let previous;
  let reason;
  if (input.supersedes !== undefined) {
    validId(input.supersedes);
    reason = text(input.reason, 'Motivo de la corrección', 1000);
    previous = active.find(e => e.id === input.supersedes);
    if (!previous) ERROR('El registro a corregir no existe o ya fue sustituido.');
    if (previous.type !== input.type || previous.lotId !== input.lotId || previous.businessDate !== input.businessDate) {
      ERROR('Una corrección debe conservar el tipo, lote y fecha efectiva del registro original.');
    }
    if (input.type === 'collection' && previous.payload.turn !== payload.turn) ERROR('La corrección debe conservar el turno de recogida.');
  } else if (input.reason !== undefined) ERROR('El motivo de corrección requiere identificar el registro original.');
  const duplicate = sameDay.find(e => e.type === input.type &&
    (SINGLE.has(input.type) || input.type === 'collection' && e.payload.turn === payload.turn));
  if (duplicate && previous?.id !== duplicate.id) ERROR('Ya existe un registro activo. Utiliza una corrección con motivo.');
  const id = input.id === undefined ? makeId() : validId(input.id);
  if (state.events.some(e => e.id === id)) ERROR('El identificador del registro ya existe.');
  if (input.type === 'close') {
    const day = getDaySummary(state, input.lotId, input.businessDate);
    if (day.collections.length !== 3) ERROR('Faltan las tres recogidas para cerrar.');
    if (!day.classEventId) ERROR('Falta el informe de clasificación para cerrar.');
    if (day.difference !== 0) ERROR('Hay huevo pendiente de clasificar o una diferencia sin conciliar.');
    if (!day.supplyEventId || !day.mortalityEventId) ERROR('Falta el informe de suministro o mortalidad. Registra cero cuando corresponda.');
  }
  const event = { id, type: input.type, lotId: input.lotId, businessDate: input.businessDate,
    payload, recordedAt: new Date().toISOString(), ...(previous ? { supersedes: previous.id, reason } : {}) };
  const next = { ...state, lots: state.lots.map(clone), events: [...state.events.map(clone), event] };
  // Revalidate every affected date: backdated input cannot silently break a later balance.
  const dates = [...new Set(getActiveEvents(next).filter(e => e.lotId === input.lotId).map(e => e.businessDate))].sort();
  for (const date of dates) {
    const day = getDaySummary(next, input.lotId, date);
    if (day.difference < 0) ERROR('La clasificación supera las recogidas del día. Este piloto no admite represamiento de otras fechas.');
    if (day.birds < 0) ERROR('La mortalidad supera las aves disponibles.');
    if (getStock(next, input.lotId, date).feedBags < -1e-9) ERROR('El suministro supera el alimento disponible en bodega.');
  }
  return next;
}

export function createDemoState(today = '2026-10-18') {
  validDate(today);
  const offset = amount => {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + amount);
    return date.toISOString().slice(0, 10);
  };
  let state = createEmptyState({ code: 'DEMO-01', name: 'Ejemplo ficticio', site: 'Sede de demostración',
    initialBirds: 12000, startDate: offset(-6), formula: 'Fórmula de ejemplo', openingFeedBags: 500 });
  state.mode = 'demo';
  const lotId = state.selectedLotId;
  for (let i = -6; i <= 0; i++) {
    const businessDate = offset(i);
    const add = (type, payload) => { state = recordEvent(state, { type, lotId, businessDate, payload }); };
    add('collection', { turn: 1, quantity: 3500 });
    add('collection', { turn: 2, quantity: 4000 });
    if (i < 0) add('collection', { turn: 3, quantity: 2000 });
    add('classification', { quantities: i < 0 ? { AA: 7000, EXTRA: 2000, A: 470 } : { AA: 5000, EXTRA: 1500, A: 300 },
      dirty: i < 0 ? 20 : 180, lost: i < 0 ? 10 : 20 });
    add('supply', { bags: 32 });
    add('mortality', { quantity: 1 });
    if (i < 0) add('close', { closedBy: 'Revisor de demostración' });
  }
  return state;
}
