import { assertOperationalCatalog } from "../offline/catalog-contract.mjs";
export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const timeNow = () =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
const $ = (s) => document.querySelector(s);
export function createFeedWorkspace(hooks) {
  let user = null,
    company = "",
    epoch = 0,
    busy = false,
    directory = null,
    scope = [];
  const errors = {
    INVALID_CREDENTIALS: "Correo o contraseña incorrectos.",
    CORRECTION_SCOPE:
      "El original no corresponde al lote y galpón seleccionados, o su conteo aprobado cambió. Revisa el ámbito antes de continuar.",
    FEED_INVENTORY_FORBIDDEN:
      "Tu permiso actual no permite gestionar este registro. Comprueba la sesión y los permisos.",
    FEED_INVENTORY_CONFLICT:
      "La versión, los vínculos o el ID entraron en conflicto. Conserva la intención y consulta el estado vigente antes de revisarla otra vez.",
    SESSION_IDENTITY_MISMATCH:
      "La sesión cambió de persona. Se retiraron los datos anteriores. Vuelve a identificarte.",
    AUTHENTICATION_REQUIRED: "Vuelve a identificarte.",
    INVALID_CATALOG: "No se pudo verificar el catálogo o los permisos.",
    FEED_OPENING_FORBIDDEN: "Tu permiso actual no permite esta acción.",
    FEED_DELIVERY_FORBIDDEN:
      "Tu permiso actual no permite registrar la recepción.",
    FEED_OPENING_CONFLICT:
      "La versión o el ID entró en conflicto. Conserva la intención y vuelve a consultar.",
    FEED_DELIVERY_CONFLICT:
      "El ID de recepción entró en conflicto. No crees otro registro para ocultarlo.",
    FEED_OPENING_NOT_FOUND: "El caso no está disponible en tu ámbito.",
    FEED_DELIVERY_NOT_FOUND: "La recepción no está disponible en tu ámbito.",
    INVALID_INTENT: "Revisa cantidades, fecha, producto, ubicación y soporte.",
    INVALID_RESPONSE:
      "La respuesta no es compatible. No se confirmó esta acción.",
    CONTEXT_CHANGED:
      "El caso cambió. Actualiza antes de revisar otra intención.",
  };
  const state = {
    get user() {
      return user;
    },
    get company() {
      return company;
    },
    get generation() {
      return epoch;
    },
    get busy() {
      return busy;
    },
    get directory() {
      return directory;
    },
    get root() {
      return `/v1/companies/${company}`;
    },
    permitted(id) {
      return scope.find((r) => r.lot_id === id)?.can_record === true;
    },
    lot(id) {
      return directory?.lots.find((r) => r.id === id);
    },
    label(id) {
      const l = state.lot(id);
      return l
        ? `${l.code} · ${directory.houses.find((h) => h.id === l.house_id)?.name ?? l.house_id} · ${directory.sites.find((s) => s.id === l.site_id)?.name ?? l.site_id}`
        : `Lote ${id}`;
    },
    say(value) {
      $("#message").textContent = value;
    },
    error(value) {
      $("#error").textContent = value;
      $("#error").hidden = false;
    },
    locks() {
      for (const id of ["logout", "refreshAccount"])
        $(`#${id}`).disabled = busy;
      $("#company").disabled = busy || hooks.hasIntent();
      for (const id of ["loginForm", "passwordForm"])
        for (const el of $(`#${id}`).elements) el.disabled = busy;
      hooks.locks();
    },
    async api(path, { method = "GET", body } = {}, at = epoch) {
      let r, data;
      try {
        r = await fetch(path, {
          method,
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            ...(user ? { "x-tamago-user": user } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(15000),
        });
        data = await r.json();
      } catch {
        if (at !== epoch) throw new Error("CANCELLED");
        throw new Error("NETWORK_UNCERTAIN");
      }
      if (at !== epoch) throw new Error("CANCELLED");
      if (!r.ok)
        throw Object.assign(new Error(data?.error ?? "UNAVAILABLE"), {
          status: r.status,
        });
      return data;
    },
    async verify() {
      const me = await state.api("/v1/auth/me");
      if (me.user_id !== user || me.password_change_required)
        throw Object.assign(new Error("SESSION_IDENTITY_MISMATCH"), {
          status: 409,
        });
    },
    async loadScope() {
      scope = [];
      state.locks();
      const [catalog, permissions] = await Promise.all([
        state.api(`${state.root}/operational-catalog`),
        state.api(`${state.root}/feed-supply-context`),
      ]);
      try {
        assertOperationalCatalog(catalog, company);
      } catch {
        throw new Error("INVALID_CATALOG");
      }
      if (
        permissions?.company_id !== company ||
        !Array.isArray(permissions.lots) ||
        permissions.lots.some(
          (r) =>
            !uuid.test(r?.lot_id ?? "") || typeof r.can_record !== "boolean",
        ) ||
        new Set(permissions.lots.map((r) => r.lot_id)).size !==
          permissions.lots.length ||
        catalog.lots.some(
          (l) =>
            catalog.houses.find((h) => h.id === l.house_id)?.site_id !==
            l.site_id,
        )
      )
        throw new Error("INVALID_CATALOG");
      directory = catalog;
      scope = permissions.lots;
      const selected = $("#lot").value;
      $("#lot").replaceChildren(new Option("Elige lote y galpón…", ""));
      for (const l of catalog.lots.filter((l) =>
        scope.some((r) => r.lot_id === l.id),
      ))
        $("#lot").add(
          new Option(
            state.label(l.id) +
              (state.permitted(l.id) ? "" : " · solo consulta"),
            l.id,
          ),
        );
      if ([...$("#lot").options].some((o) => o.value === selected))
        $("#lot").value = selected;
    },
    async run(action) {
      if (busy) return;
      busy = true;
      $("#error").hidden = true;
      state.locks();
      try {
        await action();
      } catch (e) {
        if (e.message !== "CANCELLED") {
          if (e.status === 401 || e.message === "SESSION_IDENTITY_MISMATCH") {
            clear();
            $("#loginPanel").hidden = false;
          }
          state.error(
            errors[e.message] ??
              "No se pudo completar la operación. Conserva esta pestaña y comprueba la conexión.",
          );
        }
      } finally {
        busy = false;
        state.locks();
      }
    },
    start() {
      clear();
      void state.run(async () => {
        try {
          await enter(await state.api("/v1/auth/me"));
        } catch (e) {
          $("#loginPanel").hidden = false;
          if (e.status !== 401) throw e;
          state.say("Inicia sesión para registrar y consultar alimento.");
        }
      });
    },
  };
  function clear() {
    epoch++;
    user = null;
    company = "";
    directory = null;
    scope = [];
    for (const id of ["workspace", "accountPanel", "passwordPanel", "logout"])
      $(`#${id}`).hidden = true;
    $("#company").replaceChildren();
    $("#lot").replaceChildren();
    $("#identity").textContent = "";
    hooks.reset();
  }
  async function enter(me) {
    if (!uuid.test(me.user_id ?? "")) throw new Error("INVALID_RESPONSE");
    clear();
    user = me.user_id;
    $("#loginPanel").hidden = true;
    $("#logout").hidden = false;
    $("#identity").textContent = `Cuenta verificada · ${user}`;
    if (me.password_change_required) {
      $("#passwordPanel").hidden = false;
      return;
    }
    const companies = await state.api("/v1/companies");
    if (
      !Array.isArray(companies) ||
      companies.some(
        (c) => !uuid.test(c?.id ?? "") || typeof c.legal_name !== "string",
      )
    )
      throw new Error("INVALID_CATALOG");
    $("#company").add(new Option("Elige empresa…", ""));
    for (const c of companies)
      $("#company").add(new Option(c.legal_name, c.id));
    $("#accountPanel").hidden = false;
    if (companies.length === 1) {
      $("#company").value = companies[0].id;
      await chooseCompany();
    }
    state.say(
      companies.length
        ? "Solo una confirmación válida acredita el registro en servidor."
        : "No tienes empresas activas asignadas.",
    );
  }
  async function chooseCompany() {
    epoch++;
    company = $("#company").value;
    directory = null;
    scope = [];
    hooks.reset();
    $("#lot").replaceChildren();
    $("#workspace").hidden = !company;
    if (company) {
      await state.verify();
      await state.loadScope();
      await hooks.companyChanged();
    }
  }
  $("#loginForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(e.currentTarget));
    void state.run(async () => {
      const me = await state.api("/v1/auth/login", {
        method: "POST",
        body: fields,
      });
      $("#loginForm").reset();
      await enter(me);
    });
  });
  $("#passwordForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget));
    if (d.password !== d.confirmation) {
      state.error("Las contraseñas deben coincidir.");
      return;
    }
    void state.run(async () => {
      await state.api("/v1/auth/change-initial-password", {
        method: "POST",
        body: { new_password: d.password },
      });
      $("#passwordForm").reset();
      await enter(await state.api("/v1/auth/me"));
    });
  });
  $("#logout").addEventListener(
    "click",
    () =>
      void state.run(async () => {
        clear();
        try {
          await state.api("/v1/auth/logout", { method: "POST", body: {} });
        } finally {
          $("#loginPanel").hidden = false;
          state.say("Sesión cerrada. Borradores de esta pestaña retirados.");
        }
      }),
  );
  $("#company").addEventListener("change", () => void state.run(chooseCompany));
  $("#refreshAccount").addEventListener(
    "click",
    () =>
      void state.run(async () => {
        await state.verify();
        if (company) {
          await state.loadScope();
          await hooks.refreshed();
        }
        state.say("Sesión y permisos comprobados.");
      }),
  );
  for (const event of ["online", "offline"])
    addEventListener(event, () => {
      state.locks();
      state.say(
        navigator.onLine
          ? "Conexión disponible; comprueba la sesión."
          : "Sin conexión: estas pantallas no guardan offline. Conserva esta pestaña.",
      );
    });
  return state;
}
