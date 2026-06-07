const setupPanel = document.querySelector("#setupPanel");
const loginPanel = document.querySelector("#loginPanel");
const settingsPanel = document.querySelector("#settingsPanel");
const setupForm = document.querySelector("#setupForm");
const loginForm = document.querySelector("#loginForm");
const settingsForm = document.querySelector("#settingsForm");
const logoutBtn = document.querySelector("#logoutBtn");
const testMapsBtn = document.querySelector("#testMapsBtn");
const adminNote = document.querySelector("#adminNote");
const mapsKeyStatus = document.querySelector("#mapsKeyStatus");

function showPanel(panel) {
  [setupPanel, loginPanel, settingsPanel].forEach((item) => {
    item.hidden = item !== panel;
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Error inesperado");
  return data;
}

async function loadStatus() {
  adminNote.textContent = "";
  const status = await api("/api/admin/status");

  if (status.setupRequired) {
    showPanel(setupPanel);
    return;
  }

  if (!status.authenticated) {
    showPanel(loginPanel);
    return;
  }

  await loadSettings();
}

async function loadSettings() {
  const settings = await api("/api/admin/settings");
  settingsForm.businessName.value = settings.businessName || "";
  settingsForm.whatsapp.value = settings.whatsapp || "";
  settingsForm.email.value = settings.email || "";
  settingsForm.googleMapsApiKey.value = "";
  mapsKeyStatus.textContent = settings.hasGoogleMapsApiKey
    ? "Google Maps esta configurado. Para cambiar la key, escribe una nueva."
    : "Google Maps aun no esta configurado.";
  showPanel(settingsPanel);
}

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/admin/setup", {
      method: "POST",
      body: JSON.stringify({ password: setupForm.password.value })
    });
    adminNote.textContent = "Acceso creado.";
    await loadSettings();
  } catch (error) {
    adminNote.textContent = error.message;
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: loginForm.password.value })
    });
    loginForm.reset();
    await loadSettings();
  } catch (error) {
    adminNote.textContent = error.message;
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(settingsForm).entries());
    const settings = await api("/api/admin/settings", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    settingsForm.googleMapsApiKey.value = "";
    mapsKeyStatus.textContent = settings.hasGoogleMapsApiKey
      ? "Google Maps esta configurado. Para cambiar la key, escribe una nueva."
      : "Google Maps aun no esta configurado.";
    adminNote.textContent = "Cambios guardados.";
  } catch (error) {
    adminNote.textContent = error.message;
  }
});

logoutBtn.addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST", body: "{}" });
  showPanel(loginPanel);
});

testMapsBtn.addEventListener("click", async () => {
  adminNote.textContent = "Probando Google Maps...";
  try {
    const result = await api("/api/admin/test-google-maps", { method: "POST", body: "{}" });
    adminNote.textContent = `Google Maps funciona con ${result.source}. Resultados: ${result.count}. Ejemplo: ${result.sample || "sin ejemplo"}.`;
  } catch (error) {
    adminNote.textContent = error.message;
  }
});

loadStatus().catch((error) => {
  adminNote.textContent = error.message;
});
