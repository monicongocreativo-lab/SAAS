const roles = {
  capture: "Captura",
  warehouse: "Bodega y clasificación",
  billing: "Facturación",
  transport: "Transporte",
  admin: "Administrador",
  director: "Director",
};
const $ = (selector) => document.querySelector(selector);
const loginPanel = $("#loginPanel");
const adminPanel = $("#adminPanel");
const passwordChangePanel = $("#passwordChangePanel");
const credentialPanel = $("#credentialPanel");
const message = $("#message");
const error = $("#error");
let userId = null;
let companies = [];
let memberships = [];

function setMessage(value = "") {
  message.textContent = value;
  error.hidden = true;
  error.textContent = "";
}

function setError(value) {
  error.textContent = value;
  error.hidden = false;
  message.textContent = "";
}

function explainError(code) {
  return (
    {
      AUTHENTICATION_REQUIRED: "La sesión venció. Inicia sesión de nuevo.",
      PASSWORD_CHANGE_REQUIRED: "Cambia la contraseña temporal para continuar.",
      NEW_PASSWORD_MUST_DIFFER:
        "La nueva contraseña debe ser diferente de la temporal.",
      INVALID_CREDENTIALS: "Correo o contraseña incorrectos.",
      IDENTITY_CREATION_FORBIDDEN:
        "Tu rol no permite crear identidades con ese rol en esta empresa.",
      IDENTITY_EMAIL_ALREADY_EXISTS_OR_REJECTED:
        "El correo ya tiene una identidad o Auth rechazó la creación. No se creó una segunda cuenta; revisa el estado antes de reintentar.",
      PROVISIONING_REQUIRES_RECOVERY:
        "La operación requiere revisión administrativa antes de reintentar.",
      PROVISIONING_CREDENTIAL_ALREADY_ACKNOWLEDGED:
        "La entrega ya se confirmó y la contraseña fue borrada; crea una operación nueva si hace falta.",
      PROVISIONING_RECOVERY_REQUIRED:
        "No se confirmó la membresía. Revisa la operación antes de continuar.",
      MEMBERSHIP_ACCESS_DENIED:
        "Tu rol no permite consultar miembros de esta empresa.",
      MEMBERSHIP_ACTION_FORBIDDEN: "Tu rol no permite realizar ese cambio.",
      MEMBERSHIP_ALREADY_EXISTS:
        "Esa identidad ya tiene una membresía vigente.",
      MEMBERSHIP_TARGET_NOT_FOUND:
        "No se encontró la cuenta Auth. Verifica su UUID.",
      MEMBERSHIP_ACTION_INVALID:
        "La membresía cambió o ya no admite esa acción. Actualiza la lista.",
    }[code] ??
    "No se pudo completar la solicitud. Comprueba la conexión y vuelve a intentar."
  );
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
  return body;
}

async function enter(user) {
  userId = user.user_id;
  $("#userId").textContent = userId;
  loginPanel.hidden = true;
  if (user.password_change_required) {
    adminPanel.hidden = true;
    passwordChangePanel.hidden = false;
    credentialPanel.hidden = true;
    $("#deliveryRecoveryPanel").hidden = true;
    $("#logout").hidden = false;
    setMessage(
      "La contraseña temporal debe cambiarse antes de usar el sistema.",
    );
    return;
  }
  passwordChangePanel.hidden = true;
  loginPanel.hidden = true;
  adminPanel.hidden = false;
  $("#logout").hidden = false;
  try {
    companies = await request("/v1/companies");
    const select = $("#companySelect");
    select.replaceChildren(
      ...companies.map((company) => {
        const option = document.createElement("option");
        option.value = company.id;
        option.textContent = `${company.legal_name} · ${company.code}`;
        return option;
      }),
    );
    select.disabled = companies.length === 0;
    if (!companies.length) {
      $("#membershipSummary").textContent =
        "Esta identidad no tiene empresas activas asignadas.";
      return;
    }
    await loadMemberships();
    let pendingDraft = null;
    try {
      pendingDraft = JSON.parse(
        sessionStorage.getItem("tamago.pendingIdentityProvisioning") ?? "null",
      );
    } catch {
      pendingDraft = null;
    }
    const canRecover =
      pendingDraft &&
      companies.some(({ id }) => id === pendingDraft.company_id);
    $("#recoverCredential").hidden = !canRecover;
    credentialPanel.hidden = !canRecover;
    $("#temporaryPassword").value = "";
    const manager =
      currentRoles().has("admin") || currentRoles().has("director");
    $("#deliveryRecoveryPanel").hidden = !manager;
    setMessage(
      "Sesión verificada. Los cambios requieren confirmación del servidor.",
    );
  } catch (cause) {
    setError(explainError(cause.message));
  }
}

function currentCompany() {
  return companies.find((company) => company.id === $("#companySelect").value);
}

function currentRoles() {
  const self = memberships.find((member) => member.user_id === userId);
  if (self?.status !== "active") return new Set();
  return new Set(
    self.roles.filter((role) => !role.revoked_at).map((role) => role.role_key),
  );
}

async function loadMemberships() {
  const company = currentCompany();
  if (!company) return;
  memberships = await request(
    `/v1/companies/${encodeURIComponent(company.id)}/memberships`,
  );
  renderMemberships();
}

function addAction(
  container,
  label,
  action,
  membershipId,
  roleKey,
  danger = false,
) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (danger) button.className = "danger";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await request(
        `/v1/companies/${encodeURIComponent(currentCompany().id)}/memberships/${encodeURIComponent(membershipId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            action,
            ...(roleKey ? { role_key: roleKey } : {}),
          }),
        },
      );
      await loadMemberships();
      setMessage("Cambio guardado por el servidor.");
    } catch (cause) {
      setError(explainError(cause.message));
    } finally {
      button.disabled = false;
    }
  });
  container.append(button);
}

function renderMemberships() {
  const body = $("#members");
  body.replaceChildren();
  const permissions = currentRoles();
  const canManage = permissions.has("admin") || permissions.has("director");
  const canManagePrivileged = permissions.has("director");
  const inviteRoles = Object.keys(roles).filter((role) =>
    canManagePrivileged
      ? true
      : canManage && !["admin", "director"].includes(role),
  );
  const roleSelect = $("#inviteForm [name=role_key]");
  const createRoleSelect = $("#createIdentityForm [name=role_key]");
  const availableRoles = inviteRoles.filter((role) => role !== "director");
  roleSelect.replaceChildren(
    ...inviteRoles.map((role) => {
      const option = document.createElement("option");
      option.value = role;
      option.textContent = roles[role];
      return option;
    }),
  );
  createRoleSelect.replaceChildren(
    ...availableRoles.map((role) => {
      const option = document.createElement("option");
      option.value = role;
      option.textContent = roles[role];
      return option;
    }),
  );
  $("#createIdentityForm button").disabled =
    !canManage || availableRoles.length === 0;
  $("#createIdentityForm [name=email]").disabled = !canManage;
  createRoleSelect.disabled = !canManage;
  $("#inviteForm button").disabled = !canManage || inviteRoles.length === 0;
  $("#inviteForm [name=user_id]").disabled = !canManage;
  $("#inviteForm [name=role_key]").disabled = !canManage;
  $("#membershipSummary").textContent = memberships.length
    ? `${memberships.length} membresía(s). El servidor aplica el permiso definitivo.`
    : "No hay membresías visibles en esta empresa.";

  for (const membership of memberships) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const code = document.createElement("code");
    code.textContent = membership.user_id;
    identity.append(code);
    const status = document.createElement("td");
    const chip = document.createElement("span");
    chip.className = "status-chip";
    chip.textContent =
      {
        active: "Activa",
        invited: "Invitada",
        suspended: "Suspendida",
        revoked: "Revocada",
      }[membership.status] ?? membership.status;
    status.append(chip);
    const roleCell = document.createElement("td");
    const roleList = document.createElement("div");
    roleList.className = "roles";
    const activeRoles = membership.roles.filter((role) => !role.revoked_at);
    for (const assignment of activeRoles) {
      const badge = document.createElement("span");
      badge.className = "role-chip";
      badge.textContent = roles[assignment.role_key] ?? assignment.role_key;
      roleList.append(badge);
    }
    if (!activeRoles.length) roleList.textContent = "Sin rol vigente";
    roleCell.append(roleList);
    const actions = document.createElement("td");
    actions.className = "actions";
    if (
      canManage &&
      membership.user_id !== userId &&
      membership.status !== "revoked"
    ) {
      if (membership.status === "active") {
        addAction(actions, "Suspender", "suspend", membership.id);
        addAction(actions, "Revocar", "revoke", membership.id, null, true);
      } else if (membership.status === "suspended") {
        addAction(actions, "Reactivar", "reactivate", membership.id);
        addAction(actions, "Revocar", "revoke", membership.id, null, true);
      } else if (membership.status === "invited") {
        addAction(actions, "Cancelar", "revoke", membership.id, null, true);
      }
      for (const assignment of activeRoles) {
        if (
          !canManagePrivileged &&
          ["admin", "director"].includes(assignment.role_key)
        )
          continue;
        const label = document.createElement("button");
        label.type = "button";
        label.textContent = `Quitar ${roles[assignment.role_key] ?? assignment.role_key}`;
        label.addEventListener("click", async () => {
          label.disabled = true;
          try {
            await request(
              `/v1/companies/${encodeURIComponent(currentCompany().id)}/memberships/${encodeURIComponent(membership.id)}`,
              {
                method: "PATCH",
                body: JSON.stringify({
                  action: "revoke_role",
                  role_key: assignment.role_key,
                }),
              },
            );
            await loadMemberships();
            setMessage("Rol revocado en el servidor.");
          } catch (cause) {
            setError(explainError(cause.message));
          }
        });
        actions.append(label);
      }
    }
    row.append(identity, status, roleCell, actions);
    body.append(row);
  }
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  setMessage("Verificando credenciales…");
  try {
    const fields = new FormData(event.currentTarget);
    const user = await request("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: fields.get("email"),
        password: fields.get("password"),
      }),
    });
    await enter(user);
  } catch (cause) {
    setError(explainError(cause.message), cause.message);
  } finally {
    button.disabled = false;
  }
});

$("#passwordChangeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const fields = new FormData(form);
  const password = fields.get("new_password");
  if (password !== fields.get("confirm_password")) {
    setError("Las contraseñas no coinciden.");
    return;
  }
  button.disabled = true;
  try {
    await request("/v1/auth/change-initial-password", {
      method: "POST",
      body: JSON.stringify({ new_password: password }),
    });
    form.reset();
    await enter({ user_id: userId, password_change_required: false });
    setMessage("Contraseña cambiada. Ya puedes continuar.");
  } catch (cause) {
    setError(explainError(cause.message));
  } finally {
    button.disabled = false;
  }
});

$("#createIdentityForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const fields = new FormData(form);
  const companyId = currentCompany()?.id;
  if (!companyId) return setError("Selecciona una empresa autorizada.");
  const draft = {
    operation_id: crypto.randomUUID(),
    company_id: companyId,
    email: String(fields.get("email")).trim().toLowerCase(),
    role_key: fields.get("role_key"),
  };
  try {
    sessionStorage.setItem(
      "tamago.pendingIdentityProvisioning",
      JSON.stringify(draft),
    );
  } catch {
    setError(
      "El navegador no permite guardar la recuperación local. No se creó la cuenta.",
    );
    return;
  }
  button.disabled = true;
  try {
    await createIdentityFromDraft(draft);
    form.reset();
  } catch (cause) {
    setError(explainError(cause.message));
  } finally {
    button.disabled = false;
  }
});

async function createIdentityFromDraft(draft) {
  const result = await request(
    `/v1/companies/${encodeURIComponent(draft.company_id)}/identities`,
    {
      method: "POST",
      headers: { "idempotency-key": draft.operation_id },
      body: JSON.stringify({ email: draft.email, role_key: draft.role_key }),
    },
  );
  if (!result.temporary_password) {
    throw new Error(
      result.credential_recoverable === false
        ? "PROVISIONING_CREDENTIAL_ALREADY_ACKNOWLEDGED"
        : "PROVISIONING_REQUIRES_RECOVERY",
    );
  }
  $("#temporaryPassword").value = result.temporary_password;
  $("#credentialPanel").hidden = false;
  setMessage(
    "Identidad creada. La contraseña temporal queda visible hasta confirmar su entrega.",
  );
}

$("#copyTemporaryPassword").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#temporaryPassword").value);
    setMessage("Contraseña copiada. Entrégala por el canal externo acordado.");
  } catch {
    setError(
      "No se pudo copiar. Selecciona el campo y copia la contraseña manualmente.",
    );
  }
});

$("#recoverCredential").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const draft = JSON.parse(
      sessionStorage.getItem("tamago.pendingIdentityProvisioning") ?? "null",
    );
    if (!draft) throw new Error("PROVISIONING_REQUIRES_RECOVERY");
    await createIdentityFromDraft(draft);
  } catch (cause) {
    setError(explainError(cause.message));
  } finally {
    button.disabled = false;
  }
});

$("#acknowledgeCredential").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  let draft;
  try {
    draft = JSON.parse(
      sessionStorage.getItem("tamago.pendingIdentityProvisioning") ?? "null",
    );
  } catch {
    draft = null;
  }
  if (!draft?.operation_id || !draft?.company_id) {
    setError(
      "No se encontró el registro local de entrega para borrar la contraseña con seguridad.",
    );
    return;
  }
  button.disabled = true;
  try {
    await request(
      `/v1/companies/${encodeURIComponent(draft.company_id)}/identities/provisionings/${encodeURIComponent(draft.operation_id)}/acknowledge`,
      { method: "POST" },
    );
    sessionStorage.removeItem("tamago.pendingIdentityProvisioning");
    $("#temporaryPassword").value = "";
    credentialPanel.hidden = true;
    setMessage(
      "Confirmación guardada. La contraseña temporal fue borrada del servidor.",
    );
  } catch (cause) {
    setError(explainError(cause.message));
  } finally {
    button.disabled = false;
  }
});

$("#refreshPendingDeliveries").addEventListener("click", () =>
  loadPendingDeliveries().catch((cause) =>
    setError(explainError(cause.message)),
  ),
);

async function loadPendingDeliveries() {
  const company = currentCompany();
  if (!company) return;
  const records = await request(
    `/v1/companies/${encodeURIComponent(company.id)}/identities/provisionings/pending`,
  );
  const list = $("#pendingDeliveries");
  list.replaceChildren();
  for (const record of records) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${record.email} · ${roles[record.role_key] ?? record.role_key}`;
    const secret = document.createElement("input");
    secret.type = "password";
    secret.autocomplete = "off";
    secret.readOnly = true;
    secret.value = record.temporary_password;
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.textContent = "Mostrar contraseña";
    reveal.addEventListener("click", () => {
      secret.type = secret.type === "password" ? "text" : "password";
      reveal.textContent =
        secret.type === "password"
          ? "Mostrar contraseña"
          : "Ocultar contraseña";
    });
    const acknowledge = document.createElement("button");
    acknowledge.type = "button";
    acknowledge.className = "quiet";
    acknowledge.textContent = "Entregada; borrar clave";
    acknowledge.addEventListener("click", async () => {
      acknowledge.disabled = true;
      try {
        await request(
          `/v1/companies/${encodeURIComponent(company.id)}/identities/provisionings/${encodeURIComponent(record.operation_id)}/acknowledge`,
          { method: "POST" },
        );
        secret.value = "";
        item.remove();
        setMessage(
          "Entrega confirmada; contraseña temporal borrada del servidor.",
        );
      } catch (cause) {
        setError(explainError(cause.message));
        acknowledge.disabled = false;
      }
    });
    item.append(label, secret, reveal, acknowledge);
    list.append(item);
  }
  setMessage(
    records.length
      ? `${records.length} entrega(s) pendiente(s).`
      : "No hay entregas pendientes.",
  );
}

$("#inviteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const fields = new FormData(form);
    await request(
      `/v1/companies/${encodeURIComponent(currentCompany().id)}/memberships`,
      {
        method: "POST",
        body: JSON.stringify({
          user_id: fields.get("user_id").trim(),
          role_key: fields.get("role_key"),
        }),
      },
    );
    form.reset();
    await loadMemberships();
    setMessage(
      "Invitación de membresía creada. La persona debe aceptarla desde su propia sesión.",
    );
  } catch (cause) {
    setError(explainError(cause.message));
  } finally {
    button.disabled = false;
  }
});

$("#companySelect").addEventListener("change", () => {
  loadMemberships().catch((cause) => setError(explainError(cause.message)));
  if (!$("#deliveryRecoveryPanel").hidden)
    loadPendingDeliveries().catch((cause) =>
      setError(explainError(cause.message)),
    );
});
$("#refresh").addEventListener("click", () =>
  loadMemberships()
    .then(() => setMessage("Lista actualizada desde el servidor."))
    .catch((cause) => setError(explainError(cause.message))),
);
$("#logout").addEventListener("click", async () => {
  try {
    await request("/v1/auth/logout", { method: "POST" });
  } catch {
    // Hide the local view even if the provider is unavailable; the server clears its cookie.
  }
  userId = null;
  companies = [];
  memberships = [];
  adminPanel.hidden = true;
  passwordChangePanel.hidden = true;
  credentialPanel.hidden = true;
  $("#deliveryRecoveryPanel").hidden = true;
  loginPanel.hidden = false;
  $("#logout").hidden = true;
  $("#loginForm").reset();
  setMessage("Sesión cerrada en este dispositivo.");
});

request("/v1/auth/me")
  .then(enter)
  .catch(() =>
    setMessage("Inicia sesión para consultar las empresas autorizadas."),
  );
