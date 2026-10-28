import { operationalDate } from "./contract.mjs";
import { PasswordOfflineIdentity } from "./password-offline-identity.mjs";

export async function mountPasswordIdentity({
  request,
  authenticatedUser,
  selectedScope,
}) {
  const identity = await PasswordOfflineIdentity.open(request);
  const $ = (selector) => document.querySelector(selector);
  const prepare = $("#prepareIdentityForm");
  const unlock = $("#unlockIdentityForm");
  const select = $("#offlineProfile");
  const status = $("#identityStatus");
  const error = $("#identityError");
  const channel =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel("tamago-password-identity-lock-v1")
      : null;
  let busy = false;
  let queueBusy = false;
  let syncBusy = false;
  let queueViewEpoch = 0;
  let captureAttempt = null;
  const capture = $("#identityCaptureForm");
  const fields = $("#identityCaptureFields");
  const captureStatus = $("#identityCaptureStatus");
  const recordsList = $("#identityRecords");
  const exportButton = $("#exportIdentityCollections");
  const syncButton = $("#syncIdentityCollections");
  const syncStatus = $("#identitySyncStatus");

  function resetCapture() {
    capture.reset();
    capture.querySelector("[name=protected_business_date]").value =
      operationalDate();
    capture.querySelector("[name=protected_time]").value =
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Bogota",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date());
    captureAttempt = null;
  }

  function lock(broadcast = true) {
    queueViewEpoch += 1;
    identity.lock();
    prepare.querySelector("input").value = "";
    unlock.querySelector("input").value = "";
    status.textContent =
      "Identidad local bloqueada. Los perfiles preparados se conservan.";
    resetCapture();
    fields.disabled = true;
    recordsList.replaceChildren();
    if ($("#identityQueueSummary"))
      $("#identityQueueSummary").textContent =
        "Abre un perfil para consultar sus registros.";
    exportButton.disabled = true;
    syncButton.disabled = true;
    syncStatus.textContent =
      "Abre tu perfil y sesión online para enviar tus pendientes.";
    captureStatus.textContent =
      "Abre un perfil para registrar o consultar sus recogidas.";
    if (broadcast) channel?.postMessage("lock");
  }
  channel?.addEventListener("message", () => lock(false));
  addEventListener("pagehide", () => lock());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) lock();
  });
  select.addEventListener("change", () => lock());
  $("#lockIdentity").addEventListener("click", () => lock());

  function fail(value) {
    const messages = {
      INVALID_CREDENTIALS: "La contraseña de la cuenta no coincide.",
      PASSWORD_CONFIRM_RATE_LIMITED:
        "Demasiados intentos. Espera un minuto para volver a confirmar.",
      VAULT_UNLOCK_FAILED:
        "No se pudo abrir la clave local con esa contraseña. Si cambiaste u olvidaste tu contraseña, conserva los datos y solicita recuperación.",
      OFFLINE_IDENTITY_CANCELLED:
        "Operación cancelada porque se bloqueó o cambió la identidad.",
      OFFLINE_GRANT_FORBIDDEN:
        "El servidor no permite preparar ese ámbito para esta cuenta.",
      OFFLINE_GRANT_SIGNER_UNAVAILABLE:
        "El servicio local todavía no tiene configurada la firma de capacidades.",
      OFFLINE_ISSUER_KEY_UNAVAILABLE:
        "La clave pública del emisor no quedó disponible. Reintenta con red.",
      PROTECTED_QUEUE_OCCURRENCE_CONFLICT:
        "Esa recogida del origen diario ya existe en esta tableta. No se duplicó; solicita revisión para corregirla.",
      PROTECTED_QUEUE_EVENT_CONFLICT:
        "El mismo ID contiene datos distintos. Se conserva el original; solicita revisión.",
      COLLECTION_RECEIPT_INVALID:
        "El acuse no corresponde al registro enviado o está incompleto. Se conserva pendiente; reintenta o solicita revisión.",
      COLLECTION_RECEIPT_NOT_SAVED:
        "No se pudo conservar el acuse local. El evento sigue pendiente; reintenta con el mismo ID.",
      COLLECTION_SYNC_ACCOUNT_MISMATCH:
        "Inicia sesión online con la misma cuenta del perfil abierto para enviar sus registros.",
      AUTHENTICATION_REQUIRED:
        "Inicia sesión online antes de enviar. Las recogidas locales se conservan.",
      PROTECTED_QUEUE_NOT_SAVED:
        "No se pudo guardar la recogida. Reintenta; no se anunció como guardada.",
      VAULT_LOCAL_PAYLOAD_INVALID:
        "No se pudieron abrir los datos cifrados. Consérvalos y solicita recuperación; no se reemplazaron por registros vacíos.",
    };
    error.textContent =
      messages[value.message] ??
      `No se pudo completar la operación (${String(value.message).slice(0, 100)}). Los datos anteriores se conservan.`;
    error.hidden = false;
  }

  async function refresh() {
    const previous = identity.active?.profile_id ?? select.value;
    const rows = await identity.list();
    select.replaceChildren(
      new Option(
        rows.length
          ? "Elige un perfil preparado…"
          : "Todavía no hay perfiles preparados",
        "",
      ),
    );
    for (const row of rows) select.add(new Option(row.label, row.profile_id));
    if (rows.some((row) => row.profile_id === previous))
      select.value = previous;
    prepare.hidden = !authenticatedUser();
    prepare.querySelector("button").disabled = busy || !selectedScope();
  }

  function activeMessage(active) {
    status.textContent = `Identidad local abierta · usuario ${active.subject_user_id} · lote ${active.scope.lot_id}. ${active.grant_state === "current" ? "Capacidad firmada vigente según el reloj local; el servidor revalidará al recibir." : "Capacidad vencida: solo uso provisional, pendiente de revisión al sincronizar."} Esta prueba no cambia las recogidas sintéticas.`;
    fields.disabled = queueBusy;
    captureStatus.textContent =
      "Perfil abierto. Puedes registrar una recogida real en este ámbito.";
    syncStatus.textContent =
      "Para enviar necesitas conexión y sesión online de la misma persona. El acuse no aprueba la jornada.";
  }

  async function renderQueue() {
    const epoch = queueViewEpoch;
    if (!identity.active) return;
    const rows = await identity.collectionDeliveries();
    if (epoch !== queueViewEpoch) return;
    recordsList.replaceChildren();
    if ($("#identityQueueSummary")) {
      const pending = rows.filter((row) => row.status === "pending").length;
      const received = rows.filter((row) => row.status === "received").length;
      const review = rows.filter(
        (row) => row.status === "review_required",
      ).length;
      $("#identityQueueSummary").textContent =
        `${rows.length} registro(s) · ${pending} pendiente(s) de envío · ${received} recibido(s) · ${review} en cuarentena. Recepción no equivale a aprobación.`;
    }
    for (const {
      record: { event },
      status,
      receipt,
    } of rows) {
      const item = document.createElement("li");
      item.dataset.deliveryStatus = status;
      item.textContent = `${event.business_date} · recogida ${event.occurrence} · ${event.quantity_eggs} huevos · ${status === "pending" ? "pendiente de envío" : status === "review_required" ? `recibido en cuarentena; requiere revisión (${receipt.quarantine_reason})` : "recibido por servidor; revisión operativa pendiente"}`;
      recordsList.append(item);
    }
    if (!rows.length) {
      const item = document.createElement("li");
      item.textContent =
        "Esta identidad no tiene registros en este ámbito; ausencia no equivale a cero huevos.";
      recordsList.append(item);
    }
    exportButton.disabled = rows.length === 0;
    syncButton.disabled =
      syncBusy || !rows.some((row) => row.status === "pending");
  }

  async function execute(form, action) {
    if (busy || !form.reportValidity()) return;
    busy = true;
    error.hidden = true;
    lock();
    // Read the submitted secret before clearing the visible input below.
    status.textContent = "Comprobando identidad y almacenamiento…";
    for (const button of document.querySelectorAll(
      "#passwordIdentity button[type=submit]",
    ))
      button.disabled = true;
    try {
      activeMessage(await action());
      await renderQueue();
    } catch (failure) {
      fail(failure);
    } finally {
      busy = false;
      form.querySelector("input").value = "";
      for (const button of document.querySelectorAll(
        "#passwordIdentity button[type=submit]",
      ))
        button.disabled = false;
      await refresh();
    }
  }

  prepare.addEventListener("submit", (event) => {
    event.preventDefault();
    const password = prepare.querySelector("input").value;
    const userId = authenticatedUser();
    const scope = selectedScope();
    void execute(prepare, () => {
      if (!userId || !scope) throw new Error("OFFLINE_IDENTITY_INVALID_SCOPE");
      return identity.prepare({
        userId,
        scope,
        password,
        label: `${userId} · ${scope.company_id} · lote ${scope.lot_id}`,
      });
    });
  });
  unlock.addEventListener("submit", (event) => {
    event.preventDefault();
    const password = unlock.querySelector("input").value;
    const profileId = select.value;
    void execute(unlock, () => identity.unlock(profileId, password));
  });
  capture.addEventListener("submit", (event) => {
    event.preventDefault();
    if (queueBusy || busy || !identity.active || !capture.reportValidity())
      return;
    const values = new FormData(capture);
    const input = {
      business_date: values.get("protected_business_date"),
      occurred_at: new Date(
        `${values.get("protected_business_date")}T${values.get("protected_time")}:00-05:00`,
      ).toISOString(),
      occurrence: Number(values.get("protected_occurrence")),
      quantity_eggs: Number(values.get("protected_quantity_eggs")),
    };
    const signature = JSON.stringify(input);
    if (!captureAttempt || captureAttempt.signature !== signature)
      captureAttempt = {
        signature,
        event_id: crypto.randomUUID(),
        captured_at: new Date().toISOString(),
      };
    const attempt = {
      ...input,
      event_id: captureAttempt.event_id,
      captured_at: captureAttempt.captured_at,
    };
    const epoch = queueViewEpoch;
    queueBusy = true;
    fields.disabled = true;
    error.hidden = true;
    captureStatus.textContent = "Firmando y guardando la recogida local…";
    void (async () => {
      try {
        await identity.saveCollection(attempt);
        if (epoch !== queueViewEpoch) return;
        captureStatus.textContent =
          "Recogida firmada guardada localmente. Consulta su recepción en la lista; guardar no implica envío ni aprobación.";
        captureAttempt = null;
        capture.querySelector("[name=protected_quantity_eggs]").value = "";
        await renderQueue();
      } catch (failure) {
        if (epoch === queueViewEpoch) {
          fail(failure);
          captureStatus.textContent =
            "No se confirmó el guardado. Revisa el error y reintenta conservando los datos.";
        }
      } finally {
        queueBusy = false;
        fields.disabled = !identity.active;
      }
    })();
  });
  syncButton.addEventListener("click", () => {
    if (syncBusy || queueBusy || busy || !identity.active) return;
    const epoch = queueViewEpoch;
    syncBusy = true;
    syncButton.disabled = true;
    error.hidden = true;
    syncStatus.textContent = "Enviando pendientes y comprobando acuses…";
    void (async () => {
      try {
        const result = await identity.synchronizeCollections();
        if (epoch !== queueViewEpoch) return;
        syncStatus.textContent = `${result.received} recibido(s); ${result.review} requiere(n) revisión. La recepción no aprueba la jornada.`;
      } catch (failure) {
        if (epoch === queueViewEpoch) {
          fail(failure);
          syncStatus.textContent =
            "Envío incompleto. Solo los acuses válidos guardados cambian el estado; los demás permanecen pendientes y se pueden reintentar.";
        }
      } finally {
        syncBusy = false;
        if (epoch === queueViewEpoch && identity.active) {
          try {
            await renderQueue();
          } catch (failure) {
            fail(failure);
          }
        }
      }
    })();
  });
  exportButton.addEventListener("click", () => {
    const epoch = queueViewEpoch;
    void (async () => {
      try {
        const bundle = await identity.exportCollections();
        if (epoch !== queueViewEpoch) return;
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(bundle, null, 2)], {
            type: "application/json",
          }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = "tamago-recogidas-firmadas-v1.json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      } catch (failure) {
        if (epoch === queueViewEpoch) fail(failure);
      }
    })();
  });
  resetCapture();
  await refresh();
  setInterval(() => {
    const active = identity.active;
    if (active) activeMessage(active);
  }, 60_000);
  return { lock, refresh };
}
