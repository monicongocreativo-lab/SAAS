import { validateOriginFlowSummary } from "../shared/origin-flow-contract.mjs";

const $ = (selector) => document.querySelector(selector);
const fields = [
  ["quantity_collected", "Recogidos"],
  ["quantity_at_house", "En galpón"],
  ["quantity_in_transit", "En tránsito"],
  ["quantity_received", "Recibidos"],
  ["quantity_classified", "Clasificados"],
  ["quantity_pending_classification", "Pendientes de clasificar"],
];
export function mountOriginSummary({
  request,
  currentCompany,
  currentGeneration,
}) {
  let next = null;
  const lotLabels = {
    planned: "Planeado",
    active: "Activo",
    closed: "Cerrado",
  };
  const text = (tag, value) => {
    const node = document.createElement(tag);
    node.textContent = value;
    return node;
  };
  function clear() {
    next = null;
    $("#flowItems").replaceChildren();
    $("#flowStatus").textContent = "";
    $("#moreFlow").hidden = true;
  }
  async function load(append = false) {
    const company = currentCompany(),
      epoch = currentGeneration(),
      date = $("#flowDate").value;
    if (!company) {
      clear();
      return;
    }
    $("#flowPanel").setAttribute("aria-busy", "true");
    $("#flowStatus").textContent =
      "Consultando información recibida por servidor…";
    try {
      const result = await request(
        `/v1/companies/${company}/custody-flow?business_date=${encodeURIComponent(date)}&offset=${append ? next : 0}`,
      );
      if (epoch !== currentGeneration()) return;
      if (!validateOriginFlowSummary(result, { companyId: company, date }))
        throw new Error("INVALID_ORIGIN_FLOW");
      if (!append) $("#flowItems").replaceChildren();
      for (const row of result.items) {
        const card = document.createElement("article");
        card.className = "origin-flow-card";
        card.dataset.lotId = row.lot_id;
        card.append(
          text("h3", `${row.lot_code} · ${row.house_name} · ${row.site_name}`),
        );
        card.append(
          text(
            "p",
            `Origen ${row.origin_business_date} · estado del lote: ${lotLabels[row.lot_status] ?? row.lot_status}. ${row.collection_count} recogida(s) y ${row.receipt_count} recepción(es) confirmadas.`,
          ),
        );
        if (row.quantity_collected === null)
          card.append(
            text(
              "p",
              "Sin información de recogidas recibida para esta fecha; no equivale a cero huevos ni prueba que falten recogidas físicas. Puede haber datos locales pendientes de enviar.",
            ),
          );
        const metrics = document.createElement("dl");
        metrics.className = "origin-flow-metrics";
        for (const [key, label] of fields) {
          const cell = document.createElement("div");
          cell.dataset.metric = key;
          cell.append(
            text("dt", label),
            text(
              "dd",
              row[key] === null ? "Sin información" : `${row[key]} huevos`,
            ),
          );
          metrics.append(cell);
        }
        card.append(metrics);
        card.append(
          text(
            "p",
            `Custodia: faltantes ${row.custody_shortage} · sobrantes ${row.custody_surplus} · diferencia neta ${row.custody_difference}. Incidencias abiertas: ${row.open_incidents}.`,
          ),
        );
        card.append(
          text(
            "p",
            `Dentro de lo clasificado: destino No definido ${row.quantity_destination_undefined} · Descarte declarado ${row.quantity_discard_declared}. No se suman otra vez ni representan stock comercial o pérdida aprobada.`,
          ),
        );
        card.append(
          text(
            "small",
            `Consultado ${new Date(result.as_of).toLocaleString("es-CO", { timeZone: "America/Bogota" })} · solo consulta; no conciliación aprobada.`,
          ),
        );
        $("#flowItems").append(card);
      }
      next = result.next_offset;
      $("#moreFlow").hidden = next === null;
      $("#flowStatus").textContent = $("#flowItems").children.length
        ? `${$("#flowItems").children.length} origen(es) visibles. Actualiza para volver a consultar; las páginas pueden cambiar con nuevos registros.`
        : "No hay orígenes visibles en tu ámbito para esta consulta.";
    } catch (error) {
      if (epoch === currentGeneration()) {
        clear();
        $("#flowStatus").textContent =
          "No se pudo actualizar el recorrido. Vuelve a consultar; no se modificó ningún registro.";
      }
      throw error;
    } finally {
      if (epoch === currentGeneration())
        $("#flowPanel").setAttribute("aria-busy", "false");
    }
  }
  return { clear, load };
}
