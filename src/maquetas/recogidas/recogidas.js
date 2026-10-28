const companies = {
  paulina: {
    name: "La Paulina",
    logo: "./assets/la-paulina-simbolo.png",
    farm: "Finca El Recuerdo",
    lot: "LP-08",
    house: "Galpón 3",
  },
  tamago: {
    name: "Tamago",
    logo: "./assets/tamago.png",
    farm: "Granja El Roble",
    lot: "TM-12",
    house: "Galpón 2",
  },
  transagro: {
    name: "Transagro",
    logo: "./assets/transagro.png",
    farm: "Centro de acopio",
    lot: "TR-04",
    house: "Galpón 1",
  },
};

let selectedPerson = { name: "Ana Rodríguez", role: "Galponera" };
let offline = false;
let selectedCompany = "paulina";

const screenNames = ["identificar", "registrar", "estado"];
const feedback = document.querySelector("#feedback");
const companySelect = document.querySelector("#companySelect");

function announce(message) {
  feedback.textContent = message;
  feedback.hidden = false;
}

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.hidden = screen.id !== `screen-${name}`;
  });
  document.querySelectorAll(".step").forEach((step, index) => {
    const active = step.dataset.go === name;
    step.classList.toggle("active", active);
    step.classList.toggle("done", screenNames.indexOf(name) > index);
    if (active) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
  feedback.hidden = true;
  document.querySelector(`#screen-${name} h2`)?.focus({ preventScroll: true });
}

function updateCompany() {
  const company = companies[selectedCompany];
  document.querySelector("#companyName").textContent = company.name;
  document
    .querySelector(".brand-mark")
    .classList.toggle("wide", selectedCompany === "transagro");
  const logo = document.querySelector("#companyLogo");
  logo.src = company.logo;
  logo.alt = `${company.name} (marca de ejemplo)`;
  document.querySelector("#assignedContext").textContent =
    `${company.farm} · Lote ${company.lot}`;
  document.querySelector("#activeLot").textContent =
    `${company.lot} · ${company.house}`;
}

function selectPerson(button) {
  document.querySelectorAll(".person").forEach((personButton) => {
    const selected = personButton === button;
    personButton.classList.toggle("selected", selected);
    personButton.setAttribute("aria-checked", String(selected));
    personButton.tabIndex = selected ? 0 : -1;
  });
  selectedPerson = { name: button.dataset.person, role: button.dataset.role };
}

document.querySelectorAll(".person").forEach((button) => {
  button.addEventListener("click", () => selectPerson(button));
  button.addEventListener("keydown", (event) => {
    if (
      !["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)
    )
      return;
    event.preventDefault();
    const people = [...document.querySelectorAll(".person")];
    const direction = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1;
    const next =
      (people.indexOf(button) + direction + people.length) % people.length;
    selectPerson(people[next]);
    people[next].focus();
  });
});

document.querySelectorAll("[data-go], [data-next]").forEach((button) => {
  button.addEventListener("click", () =>
    showScreen(button.dataset.go ?? button.dataset.next),
  );
});
companySelect.addEventListener("change", () => {
  selectedCompany = companySelect.value;
  updateCompany();
  announce(
    "Empresa de ejemplo cambiada. En la app final, el acceso dependerá de la sesión y los permisos autorizados.",
  );
});

document.querySelector("#networkToggle").addEventListener("click", (event) => {
  offline = !offline;
  const button = event.currentTarget;
  button.classList.toggle("offline", offline);
  button.setAttribute("aria-pressed", String(offline));
  document.querySelector("#networkLabel").textContent = offline
    ? "Sin conexión · demo"
    : "Con conexión";
  document.querySelector("#offlineCallout").hidden = !offline;
  announce(
    offline
      ? "Modo sin conexión de demostración. No se harán guardados ni envíos reales."
      : "Conexión de demostración activa. No se contacta ningún servidor.",
  );
});

document.querySelector("#changeContext").addEventListener("click", () => {
  announce(
    "El cambio de finca, lote y galpón requiere un catálogo autorizado. Este selector se deja pendiente en la maqueta.",
  );
});

document.querySelector("#captureForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const quantity = Number(form.elements.quantity.value);
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    document
      .querySelector("#quantity")
      .setCustomValidity(
        "Ingresa un número entero de huevos igual o mayor que cero.",
      );
    document.querySelector("#quantity").reportValidity();
    document.querySelector("#quantity").setCustomValidity("");
    return;
  }
  const turn = form.elements.turn.value;
  const company = companies[selectedCompany];
  const row = document.createElement("article");
  row.className = "record record-pending";
  const top = document.createElement("div");
  top.className = "record-top";
  const date = document.createElement("strong");
  date.textContent = "Hoy · ahora";
  const status = document.createElement("span");
  status.className = "status-tag";
  const dot = document.createElement("i");
  status.append(
    dot,
    document.createTextNode(
      offline ? "Provisional · sin envío" : "Pendiente de envío",
    ),
  );
  top.append(date, status);
  const origin = document.createElement("p");
  const originStrong = document.createElement("b");
  originStrong.textContent = company.lot;
  origin.append(
    originStrong,
    document.createTextNode(` · ${company.house} · Recogida ${turn}`),
  );
  const bottom = document.createElement("div");
  bottom.className = "record-bottom";
  const amount = document.createElement("strong");
  amount.append(
    document.createTextNode(quantity.toLocaleString("es-CO")),
    document.createTextNode(" "),
  );
  const unit = document.createElement("small");
  unit.textContent = "huevos";
  amount.append(unit);
  const saved = document.createElement("span");
  saved.textContent = offline
    ? "Ejemplo · acceso offline pendiente"
    : "Ejemplo · sin acuse del servidor";
  bottom.append(amount, saved);
  row.append(top, origin, bottom);
  document.querySelector("#recordList").prepend(row);
  const count = document.querySelectorAll("#recordList .record-pending").length;
  document.querySelector("#pendingCount").textContent = String(count);
  form.reset();
  announce(
    `Ejemplo de pantalla: ${quantity.toLocaleString("es-CO")} huevos quedarían como recogida ${turn} de ${selectedPerson.name}. Esta maqueta no conserva el registro al recargar.`,
  );
  showScreen("estado");
});

document.querySelector("#exportButton").addEventListener("click", () => {
  announce(
    "En la app final, esta acción descargará el respaldo disponible. La maqueta no crea un archivo.",
  );
});

document.querySelector("#todayLabel").textContent = new Intl.DateTimeFormat(
  "es-CO",
  {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "America/Bogota",
  },
)
  .format(new Date())
  .replace(".", "");
document.querySelector("#captureDate").textContent = new Intl.DateTimeFormat(
  "es-CO",
  {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Bogota",
  },
).format(new Date());
document.querySelector("#screen-identificar h2").tabIndex = -1;
document.querySelector("#screen-registrar h2").tabIndex = -1;
document.querySelector("#screen-estado h2").tabIndex = -1;
document.querySelector(".person.selected").tabIndex = 0;

updateCompany();
