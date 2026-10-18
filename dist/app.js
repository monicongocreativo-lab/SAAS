const views = [...document.querySelectorAll('.view')];
const navItems = [...document.querySelectorAll('.nav-item')];
const companySelect = document.querySelector('#companySelect');

const companyData = {
  grupo: { title: 'Resumen del grupo', result: '$38,4 M', cash: '$126,8 M', working: '$91,2 M' },
  pau: { title: 'Resumen de La Paulina', result: '$8,7 M', cash: '$34,2 M', working: '$42,5 M' },
  tam: { title: 'Resumen de Tamago', result: '$25,6 M', cash: '$71,4 M', working: '$37,8 M' },
  tra: { title: 'Resumen de Transagro', result: '$4,1 M', cash: '$21,2 M', working: '$10,9 M' },
};

function showView(name) {
  views.forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  navItems.forEach(item => item.classList.toggle('active', item.dataset.view === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

navItems.forEach(item => item.addEventListener('click', () => showView(item.dataset.view)));
document.querySelectorAll('[data-view-link]').forEach(button => button.addEventListener('click', () => showView(button.dataset.viewLink)));

companySelect.addEventListener('change', event => {
  const data = companyData[event.target.value];
  document.querySelector('#title-resumen').textContent = data.title;
  document.querySelector('[data-kpi="result"]').textContent = data.result;
  document.querySelector('[data-kpi="cash"]').textContent = data.cash;
  document.querySelector('[data-kpi="working"]').textContent = data.working;
});

document.querySelectorAll('[data-company-tab]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-company-tab]').forEach(item => item.classList.remove('active'));
    tab.classList.add('active');
    const map = { tam: 'tam', pau: 'pau', tra: 'tra' };
    companySelect.value = map[tab.dataset.companyTab];
    const names = {
      tam: ['TAM', 'Producción y clasificación', 'Lote T-2604 · 8.620 aves · semana de edad 41'],
      pau: ['PAU', 'Levante, consumo y sanidad', 'Lote P-2611 · 9.140 aves · semana de edad 14'],
      tra: ['TRA', 'Viajes y costos logísticos', '14 viajes · 3 vehículos · semana 36'],
    };
    const [code, title, description] = names[tab.dataset.companyTab];
    const badge = document.querySelector('.operation-title .company-badge');
    badge.textContent = code;
    badge.className = `company-badge ${tab.dataset.companyTab}`;
    document.querySelector('.operation-title h2').textContent = title;
    document.querySelector('.operation-title p').textContent = description;
  });
});

const dialog = document.querySelector('#captureDialog');
const captureType = document.querySelector('#captureType');
const captureCompany = document.querySelector('#captureCompany');
const companyLabels = { tam: 'Tamago', pau: 'La Paulina', tra: 'Transagro', grupo: 'Tamago' };

function openCapture(type) {
  captureCompany.value = companyLabels[companySelect.value] || 'Tamago';
  if (type && [...captureType.options].some(option => option.text === type)) captureType.value = type;
  dialog.showModal();
}

document.querySelectorAll('[data-open-capture]').forEach(button => button.addEventListener('click', () => openCapture()));
document.querySelectorAll('[data-capture-type]').forEach(button => button.addEventListener('click', () => openCapture(button.dataset.captureType)));

document.querySelector('#saveCapture').addEventListener('click', event => {
  event.preventDefault();
  dialog.close();
  const toast = document.querySelector('#toast');
  toast.querySelector('strong').textContent = `${captureType.value} guardado`;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 3200);
});

dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
});

const feedDefaults = { sollaKg: 7000, haciendaKg: 7000, sollaCost: 2300, haciendaCost: 2050, sollaEggs: 55000, haciendaEggs: 52000, sollaPremium: 53, haciendaPremium: 38, premiumPrice: 520, standardPrice: 390 };
const feedIds = Object.keys(feedDefaults);
const feedInputs = feedIds.map(id => document.querySelector(`#${id}`));

const number = id => Number(document.querySelector(`#${id}`).value) || 0;
const money = value => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value);
const compactMoney = value => `${value < 0 ? '−' : ''}$${(Math.abs(value) / 1000000).toLocaleString('es-CO', { maximumFractionDigits: 1 })} M`;

function feedScenario(prefix) {
  const kg = number(`${prefix}Kg`);
  const costPerKg = number(`${prefix}Cost`);
  const eggs = number(`${prefix}Eggs`);
  const premiumShare = Math.max(0, Math.min(100, number(`${prefix}Premium`))) / 100;
  const revenue = eggs * (premiumShare * number('premiumPrice') + (1 - premiumShare) * number('standardPrice'));
  const feedCost = kg * costPerKg;
  return { kg, eggs, revenue, feedCost, contribution: revenue - feedCost, eggsPerKg: kg ? eggs / kg : 0, valueKg: kg ? revenue / kg : 0 };
}

function updateFeed() {
  const solla = feedScenario('solla');
  const hacienda = feedScenario('hacienda');
  const advantage = solla.contribution - hacienda.contribution;
  const winner = advantage >= 0 ? 'Solla' : 'Hacienda';
  const base = advantage >= 0 ? Math.abs(hacienda.contribution) : Math.abs(solla.contribution);
  const pct = base ? Math.abs(advantage) / base * 100 : 0;
  document.querySelector('#feedWinner').textContent = `${winner} · ${advantage >= 0 ? '+' : ''}${compactMoney(Math.abs(advantage))}`;
  document.querySelector('#feedWinnerPct').textContent = `${pct.toLocaleString('es-CO', { maximumFractionDigits: 1 })}% más contribución`;
  document.querySelector('#sollaContribution').textContent = compactMoney(solla.contribution);
  document.querySelector('#haciendaContribution').textContent = compactMoney(hacienda.contribution);
  document.querySelector('#sollaRevenue').textContent = compactMoney(solla.revenue);
  document.querySelector('#haciendaRevenue').textContent = `Hacienda ${compactMoney(hacienda.revenue)}`;
  document.querySelector('#sollaFeedCost').textContent = compactMoney(solla.feedCost);
  document.querySelector('#haciendaFeedCost').textContent = `Hacienda ${compactMoney(hacienda.feedCost)}`;
  document.querySelector('#sollaFcr').textContent = solla.eggsPerKg.toLocaleString('es-CO', { maximumFractionDigits: 2 });
  document.querySelector('#haciendaFcr').textContent = `Hacienda ${hacienda.eggsPerKg.toLocaleString('es-CO', { maximumFractionDigits: 2 })}`;
  document.querySelector('#sollaValueKg').textContent = money(solla.valueKg);
  document.querySelector('#haciendaValueKg').textContent = `Hacienda ${money(hacienda.valueKg)}`;
  const maximum = Math.max(Math.abs(solla.contribution), Math.abs(hacienda.contribution), 1);
  document.querySelector('#sollaBar').style.width = `${Math.max(4, Math.abs(solla.contribution) / maximum * 100)}%`;
  document.querySelector('#haciendaBar').style.width = `${Math.max(4, Math.abs(hacienda.contribution) / maximum * 100)}%`;
}

feedInputs.forEach(input => input.addEventListener('input', updateFeed));
document.querySelector('#resetFeed').addEventListener('click', () => {
  for (const [id, value] of Object.entries(feedDefaults)) document.querySelector(`#${id}`).value = value;
  updateFeed();
});
updateFeed();

const promptLibrary = {
  observation: 'Actúa como investigador de operaciones y UX. Analiza estas notas de observación de [ROL] durante [PROCESO]. No diseñes pantallas todavía. Devuelve: secuencia cronológica, objetivo de cada paso, entradas y salidas, decisiones, esperas, recapturas, errores y recuperaciones, datos conocidos en ese momento, datos heredables y preguntas pendientes. Distingue hecho observado, interpretación e hipótesis. Si falta evidencia, escribe “no determinado”. Notas: [PEGAR NOTAS].',
  story: 'Convierte este flujo UX en una historia implementable. Incluye actor, intención, valor, precondiciones, camino principal, excepciones, campos obligatorios/heredados/calculados, estados, permisos, reglas, mensajes de error, eventos analíticos, criterios Given/When/Then y fuera de alcance. No inventes reglas. Marca [REQUIERE DECISIÓN] cuando falte dueño, unidad, tolerancia o política. Flujo: [PEGAR FLUJO].',
  event: 'Actúa como arquitecto de datos event-driven. A partir de [HISTORIA], propón el contrato JSON de [EVENTO]. Separa encabezado canónico y payload tipado. Incluye tenant_id, company_id, site_id, lot_id, business_date, occurred_at, recorded_at, recorded_by, local_event_id, idempotency_key, status, version y supersedes_event_id cuando aplique. Define validaciones, claves de unicidad, transiciones, permisos y ejemplos válido/inválido. No conviertas ausencia en cero. Señala decisiones de negocio no resueltas.',
  formula: 'Formaliza la métrica [NOMBRE] para software. Devuelve pregunta, fórmula simbólica, numerador, denominador, población, grano, periodo, unidades, dimensiones, inclusiones, exclusiones, fuente de cada variable, manejo de cero/faltante/no aplica, redondeo, versión, responsable, estado mínimo, reconciliación, ejemplo y pruebas. Rechaza la fórmula si mezcla poblaciones o periodos incompatibles. Contexto: [CONTEXTO].',
  feed: 'Actúa como equipo de zootecnia avícola, estadística causal y control financiero. Diseña un protocolo para comparar [ALIMENTO A] y [ALIMENTO B]. Define unidad experimental, asignación o crossover, adaptación, duración, potencia, resultado primario, aves-día, consumo real, masa y clases, precios netos, costos incrementales, clima, agua, luz, salud, genética, manejo, mortalidad, exclusiones, bienestar y análisis. Separa descripción, inferencia ajustada y recomendación económica. Marca todo supuesto no validado.',
  gate: 'Evalúa la etapa [NÚMERO] contra esta puerta de decisión [CRITERIOS]. Usa únicamente la evidencia adjunta. Para cada criterio responde demostrado, no demostrado o parcial; cita evidencia, explica riesgo y propone la prueba mínima siguiente. Termina con una recomendación: avanzar, rediseñar o detener. No uses cantidad de pantallas o porcentaje de avance como sustituto de valor operativo.',
};

document.querySelectorAll('[data-copy-prompt]').forEach(button => {
  button.addEventListener('click', async () => {
    const prompt = promptLibrary[button.dataset.copyPrompt];
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      const toast = document.querySelector('#toast');
      toast.querySelector('strong').textContent = 'Prompt copiado';
      toast.querySelector('small').textContent = 'Completa los campos entre corchetes con evidencia real.';
      toast.classList.add('show');
      window.setTimeout(() => toast.classList.remove('show'), 3200);
    } catch (error) {
      window.prompt('Copia este prompt:', prompt);
    }
  });
});

// WebMCP: the same prototype actions are available as structured browser tools
// when the browser supports the proposed imperative Model Context API.
const modelContext = document.modelContext;
if (modelContext?.registerTool) {
  const toolLifecycle = new AbortController();
  const reportToolError = error => console.warn('WebMCP tool registration failed', error);

  const register = tool => {
    try {
      Promise.resolve(modelContext.registerTool(tool, { signal: toolLifecycle.signal })).catch(reportToolError);
    } catch (error) {
      reportToolError(error);
    }
  };

  register({
    name: 'navigate_workspace',
    title: 'Abrir módulo',
    description: 'Abre uno de los módulos visibles del prototipo del Centro de Control Empresarial.',
    inputSchema: {
      type: 'object',
      properties: { view: { type: 'string', enum: ['resumen', 'operacion', 'alimento', 'interempresas', 'registro', 'estrategia', 'handoff'] } },
      required: ['view'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute({ view }) {
      const allowedViews = ['resumen', 'operacion', 'alimento', 'interempresas', 'registro', 'estrategia', 'handoff'];
      if (!allowedViews.includes(view)) throw new Error('Módulo no válido.');
      showView(view);
      return { active_view: view };
    },
  });

  register({
    name: 'configure_feed_comparison',
    title: 'Configurar comparación de alimento',
    description: 'Actualiza los supuestos visibles de Solla y Hacienda y recalcula la contribución estimada del periodo.',
    inputSchema: {
      type: 'object',
      properties: {
        solla_kg: { type: 'number', minimum: 0 },
        hacienda_kg: { type: 'number', minimum: 0 },
        solla_cost_per_kg: { type: 'number', minimum: 0 },
        hacienda_cost_per_kg: { type: 'number', minimum: 0 },
        solla_eggs: { type: 'number', minimum: 0 },
        hacienda_eggs: { type: 'number', minimum: 0 },
        solla_premium_pct: { type: 'number', minimum: 0, maximum: 100 },
        hacienda_premium_pct: { type: 'number', minimum: 0, maximum: 100 }
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      const mapping = {
        solla_kg: 'sollaKg', hacienda_kg: 'haciendaKg',
        solla_cost_per_kg: 'sollaCost', hacienda_cost_per_kg: 'haciendaCost',
        solla_eggs: 'sollaEggs', hacienda_eggs: 'haciendaEggs',
        solla_premium_pct: 'sollaPremium', hacienda_premium_pct: 'haciendaPremium',
      };
      if (!input || Object.keys(input).some(key => !(key in mapping))) throw new Error('La comparación contiene campos no admitidos.');
      for (const [key, value] of Object.entries(input)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${key} debe ser un número no negativo.`);
        if (key.endsWith('_pct') && value > 100) throw new Error(`${key} no puede superar 100.`);
      }
      for (const [key, id] of Object.entries(mapping)) {
        if (input[key] !== undefined) document.querySelector(`#${id}`).value = input[key];
      }
      showView('alimento');
      updateFeed();
      return {
        winner: document.querySelector('#feedWinner').textContent,
        advantage: document.querySelector('#feedWinnerPct').textContent,
      };
    },
  });

  register({
    name: 'start_event_registration',
    title: 'Preparar registro operativo',
    description: 'Abre el formulario visible con la empresa y el tipo de evento seleccionados; no guarda el evento.',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', enum: ['Tamago', 'La Paulina', 'Transagro'] },
        event_type: { type: 'string', enum: ['Recogida de huevo', 'Clasificación', 'Consumo de alimento', 'Viaje entregado', 'Conteo físico'] }
      },
      required: ['company', 'event_type'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute({ company, event_type: eventType }) {
      if (!['Tamago', 'La Paulina', 'Transagro'].includes(company)) throw new Error('Empresa no válida.');
      if (!['Recogida de huevo', 'Clasificación', 'Consumo de alimento', 'Viaje entregado', 'Conteo físico'].includes(eventType)) throw new Error('Tipo de evento no válido.');
      captureCompany.value = company;
      captureType.value = eventType;
      dialog.showModal();
      return { status: 'draft_open', company, event_type: eventType };
    },
  });
}
