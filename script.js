const form = document.querySelector("#quoteForm");
const steps = Array.from(document.querySelectorAll(".form-step"));
const nextBtn = document.querySelector("#nextBtn");
const prevBtn = document.querySelector("#prevBtn");
const submitBtn = document.querySelector("#submitBtn");
const progressBar = document.querySelector("#progressBar");
const stepLabel = document.querySelector("#stepLabel");
const stepTitle = document.querySelector("#stepTitle");
const formNote = document.querySelector("#formNote");
const estimateText = document.querySelector("#estimateText");
const businessNameNodes = document.querySelectorAll(".brand span:last-child, .footer-brand span:last-child");

let currentStep = 0;
let publicConfig = {
  businessName: "Cotiza Fletes Chile",
  whatsapp: "56900000000",
  email: "cotizaciones@tu-dominio.cl",
  mapsEnabled: false
};
let autocompleteTimer;
let activeAutocompleteController;

function setStep(index) {
  currentStep = Math.max(0, Math.min(index, steps.length - 1));

  steps.forEach((step, stepIndex) => {
    step.classList.toggle("active", stepIndex === currentStep);
  });

  const activeStep = steps[currentStep];
  progressBar.style.width = `${((currentStep + 1) / steps.length) * 100}%`;
  stepLabel.textContent = `Paso ${currentStep + 1} de ${steps.length}`;
  stepTitle.textContent = activeStep.dataset.title;
  prevBtn.disabled = currentStep === 0;
  nextBtn.classList.toggle("hidden", currentStep === steps.length - 1);
  submitBtn.classList.toggle("hidden", currentStep !== steps.length - 1);
  formNote.textContent = "";
}

function validateCurrentStep() {
  const fields = Array.from(steps[currentStep].querySelectorAll("input, select, textarea"));
  const invalid = fields.find((field) => !field.checkValidity());

  if (invalid) {
    invalid.reportValidity();
    return false;
  }

  return true;
}

function getFormData() {
  const data = new FormData(form);
  const values = Object.fromEntries(data.entries());
  values.originElevator = data.has("originElevator") ? "Si" : "No";
  values.destinationElevator = data.has("destinationElevator") ? "Si" : "No";
  values.packing = data.has("packing") ? "Si" : "No";
  values.fragile = data.has("fragile") ? "Si" : "No";
  return values;
}

function calculateEstimate(values) {
  let score = 0;
  const volumeScores = {
    "Pocos bultos o cajas": 1,
    "1 ambiente": 2,
    "Departamento pequeno": 3,
    "Departamento mediano": 4,
    "Casa completa": 5,
    "Carga grande o especial": 6
  };

  score += volumeScores[values.volume] || 0;
  score += Number(values.originFloor || 0) > 2 && values.originElevator === "No" ? 2 : 0;
  score += Number(values.destinationFloor || 0) > 2 && values.destinationElevator === "No" ? 2 : 0;
  score += values.packing === "Si" ? 1 : 0;
  score += values.fragile === "Si" ? 1 : 0;
  score += values.time === "Urgente hoy" ? 2 : 0;

  if (!values.volume) return "Completa los datos para estimar prioridad";
  if (score <= 3) return "Solicitud simple: respuesta rapida";
  if (score <= 7) return "Solicitud media: requiere revisar accesos y volumen";
  return "Solicitud especial: conviene validar detalles antes de confirmar";
}

function buildMessage(values) {
  return [
    `Nueva solicitud de cotizacion para ${publicConfig.businessName}`,
    "",
    `Nombre: ${values.name}`,
    `WhatsApp: ${values.phone}`,
    `Correo: ${values.email || "No indicado"}`,
    `Servicio: ${values.service}`,
    `Fecha: ${values.date}`,
    `Horario: ${values.time}`,
    "",
    `Origen: ${values.origin}, ${values.originCommune}`,
    `Destino: ${values.destination}, ${values.destinationCommune}`,
    `Piso origen: ${values.originFloor} | Ascensor: ${values.originElevator}`,
    `Piso destino: ${values.destinationFloor} | Ascensor: ${values.destinationElevator}`,
    "",
    `Volumen: ${values.volume}`,
    `Articulos: ${values.items}`,
    `Embalaje: ${values.packing}`,
    `Fragiles: ${values.fragile}`,
    `Notas: ${values.notes || "Sin comentarios adicionales"}`
  ].join("\n");
}

async function loadPublicConfig() {
  try {
    const response = await fetch("/api/public-config", { cache: "no-store" });
    if (!response.ok) return;
    publicConfig = { ...publicConfig, ...(await response.json()) };
    businessNameNodes.forEach((node) => {
      node.textContent = publicConfig.businessName;
    });
  } catch {
    publicConfig.mapsEnabled = false;
  }
}

function closeSuggestionLists() {
  document.querySelectorAll(".address-suggestions").forEach((list) => list.remove());
}

function buildSuggestionList(input, suggestions, statusText = "") {
  closeSuggestionLists();

  const list = document.createElement("div");
  list.className = "address-suggestions";
  list.setAttribute("role", "listbox");

  if (!suggestions.length) {
    const empty = document.createElement("p");
    empty.className = "address-suggestion-status";
    empty.textContent = statusText || "No encontramos direcciones para esa busqueda.";
    list.appendChild(empty);
    input.parentElement.appendChild(list);
    return;
  }

  suggestions.forEach((suggestion) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "option");
    const main = document.createElement("strong");
    const secondary = document.createElement("span");
    main.textContent = suggestion.mainText || suggestion.text;
    secondary.textContent = suggestion.secondaryText || "";
    button.append(main, secondary);
    button.addEventListener("click", async () => {
      input.value = suggestion.text;
      buildSuggestionList(input, [], "Cargando comuna...");
      try {
        const response = await fetch(`/api/places/details?placeId=${encodeURIComponent(suggestion.placeId)}`);
        if (!response.ok) throw new Error("No se pudo cargar el detalle de la direccion.");
        const detail = await response.json();
        input.value = detail.address || suggestion.text;
        const communeInput = form.elements[input.dataset.communeTarget];
        if (communeInput && detail.commune) communeInput.value = detail.commune;
        closeSuggestionLists();
      } catch {
        input.value = suggestion.text;
        buildSuggestionList(input, [], "Seleccionamos la direccion, pero Google no entrego comuna.");
      }
    });
    list.appendChild(button);
  });

  input.parentElement.appendChild(list);
}

function setupAddressAutocomplete() {
  document.querySelectorAll("[data-address-input]").forEach((input) => {
    input.setAttribute("autocomplete", "off");
    input.addEventListener("input", () => {
      if (!publicConfig.mapsEnabled) {
        buildSuggestionList(input, [], "Google Maps no esta configurado en el panel.");
        return;
      }
      window.clearTimeout(autocompleteTimer);
      autocompleteTimer = window.setTimeout(async () => {
        const value = input.value.trim();
        if (value.length < 3) {
          closeSuggestionLists();
          return;
        }
        if (activeAutocompleteController) activeAutocompleteController.abort();
        activeAutocompleteController = new AbortController();
        buildSuggestionList(input, [], "Buscando direcciones...");
        try {
          const response = await fetch(`/api/places/autocomplete?input=${encodeURIComponent(value)}`, {
            signal: activeAutocompleteController.signal
          });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || "No se pudo consultar Google Maps.");
          }
          const data = await response.json();
          buildSuggestionList(input, data.suggestions || []);
        } catch (error) {
          if (error.name === "AbortError") return;
          buildSuggestionList(input, [], error.message);
        }
      }, 240);
    });
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".address-suggestions") && !event.target.matches("[data-address-input]")) {
      closeSuggestionLists();
    }
  });
}

function updateEstimate() {
  const values = getFormData();
  estimateText.textContent = calculateEstimate(values);
}

nextBtn.addEventListener("click", () => {
  if (validateCurrentStep()) {
    setStep(currentStep + 1);
    updateEstimate();
  }
});

prevBtn.addEventListener("click", () => {
  setStep(currentStep - 1);
});

form.addEventListener("input", updateEstimate);
form.addEventListener("change", updateEstimate);

form.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!validateCurrentStep()) return;

  const values = getFormData();
  const message = buildMessage(values);
  const encodedMessage = encodeURIComponent(message);
  const whatsappUrl = `https://wa.me/${publicConfig.whatsapp}?text=${encodedMessage}`;
  const mailtoUrl = `mailto:${publicConfig.email}?subject=${encodeURIComponent("Nueva cotizacion de flete")}&body=${encodedMessage}`;

  formNote.innerHTML = `Solicitud lista. <a href="${whatsappUrl}" target="_blank" rel="noopener">Enviar por WhatsApp</a> o <a href="${mailtoUrl}">enviar por correo</a>.`;
  window.open(whatsappUrl, "_blank", "noopener");
});

loadPublicConfig().then(setupAddressAutocomplete);
setStep(0);
