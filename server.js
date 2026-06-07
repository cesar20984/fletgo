const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const { readSettings, writeSettings } = require("./db");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4174);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8"
};

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, settings) {
  if (!settings.adminPasswordHash || !settings.adminPasswordSalt) return false;
  const { hash } = hashPassword(password, settings.adminPasswordSalt);
  const expected = Buffer.from(settings.adminPasswordHash, "hex");
  const actual = Buffer.from(hash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function sessionSecret(settings) {
  return process.env.ADMIN_SESSION_SECRET || settings.adminPasswordHash || "dev-session-secret";
}

function signSession(payload, settings) {
  return crypto
    .createHmac("sha256", sessionSecret(settings))
    .update(payload)
    .digest("base64url");
}

function isAuthed(req, settings) {
  const token = parseCookies(req).cfc_admin;
  if (!token || !token.includes(".")) return false;

  const [payload, signature] = token.split(".");
  const expected = signSession(payload, settings);
  if (!signature || signature.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.exp > Date.now();
  } catch {
    return false;
  }
}

function createSession(res, settings) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 1000 * 60 * 60 * 8 })).toString("base64url");
  const token = `${payload}.${signSession(payload, settings)}`;
  res.setHeader(
    "Set-Cookie",
    `cfc_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`
  );
}

function clearSession(req, res) {
  res.setHeader("Set-Cookie", "cfc_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  if (body.length > 20000) throw new Error("Payload demasiado grande");
  return JSON.parse(body);
}

function publicSettings(settings) {
  return {
    businessName: settings.businessName,
    whatsapp: settings.whatsapp,
    email: settings.email,
    mapsEnabled: Boolean(settings.googleMapsApiKey)
  };
}

function adminSettings(settings) {
  return {
    businessName: settings.businessName,
    whatsapp: settings.whatsapp,
    email: settings.email,
    hasGoogleMapsApiKey: Boolean(settings.googleMapsApiKey)
  };
}

function mapsErrorMessage(status, data) {
  const message = data?.error?.message || data?.error_message || data?.status || "Error desconocido";
  if (status === 403 || String(message).includes("API key")) {
    return `Google rechazo la API key: ${message}`;
  }
  return `Google Maps respondio con error: ${message}`;
}

async function googleJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.status && data.status !== "OK" && data.status !== "ZERO_RESULTS")) {
    const error = new Error(mapsErrorMessage(response.status, data));
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function normalizeNewPlacesAutocomplete(data) {
  return (data.suggestions || []).map((item) => ({
    provider: "new",
    placeId: item.placePrediction?.placeId,
    text: item.placePrediction?.text?.text || "",
    mainText: item.placePrediction?.structuredFormat?.mainText?.text || "",
    secondaryText: item.placePrediction?.structuredFormat?.secondaryText?.text || ""
  })).filter((item) => item.placeId && item.text);
}

function normalizeLegacyAutocomplete(data) {
  return (data.predictions || []).map((item) => ({
    provider: "legacy",
    placeId: item.place_id,
    text: item.description || "",
    mainText: item.structured_formatting?.main_text || "",
    secondaryText: item.structured_formatting?.secondary_text || ""
  })).filter((item) => item.placeId && item.text);
}

async function newPlacesAutocomplete(input, apiKey) {
  const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat"
    },
    body: JSON.stringify({
      input,
      languageCode: "es-419",
      regionCode: "CL",
      includedRegionCodes: ["cl"]
    })
  });
  return normalizeNewPlacesAutocomplete(await googleJson(response));
}

async function legacyPlacesAutocomplete(input, apiKey) {
  const params = new URLSearchParams({
    input,
    key: apiKey,
    language: "es-419",
    components: "country:cl",
    types: "address"
  });
  const response = await fetch(`https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`);
  return normalizeLegacyAutocomplete(await googleJson(response));
}

async function placesAutocomplete(req, res, settings) {
  if (!settings.googleMapsApiKey) return sendError(res, 400, "Google Maps API no configurada");

  const url = new URL(req.url, `http://${req.headers.host}`);
  const input = String(url.searchParams.get("input") || "").trim();
  if (input.length < 3) return sendJson(res, 200, { suggestions: [] });

  try {
    const suggestions = await newPlacesAutocomplete(input, settings.googleMapsApiKey);
    return sendJson(res, 200, { suggestions, source: "places-new" });
  } catch (newPlacesError) {
    try {
      const suggestions = await legacyPlacesAutocomplete(input, settings.googleMapsApiKey);
      return sendJson(res, 200, { suggestions, source: "places-legacy" });
    } catch (legacyError) {
      return sendError(res, 502, legacyError.message || newPlacesError.message);
    }
  }
}

function extractCommuneFromLegacyComponents(components = []) {
  const candidates = [
    "locality",
    "administrative_area_level_3",
    "sublocality",
    "sublocality_level_1"
  ];
  for (const type of candidates) {
    const match = components.find((component) => component.types?.includes(type));
    if (match?.long_name) return match.long_name;
  }
  return "";
}

async function newPlaceDetails(placeId, apiKey) {
  const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "id,formattedAddress,addressComponents,location"
    }
  });
  const data = await googleJson(response);
  const commune = (data.addressComponents || []).find((component) =>
    component.types?.includes("locality") || component.types?.includes("administrative_area_level_3")
  )?.longText || "";

  return {
    placeId: data.id,
    address: data.formattedAddress || "",
    commune,
    location: data.location || null
  };
}

async function legacyPlaceDetails(placeId, apiKey) {
  const params = new URLSearchParams({
    place_id: placeId,
    key: apiKey,
    language: "es-419",
    fields: "place_id,formatted_address,address_components,geometry"
  });
  const response = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?${params}`);
  const data = await googleJson(response);
  const result = data.result || {};

  return {
    placeId: result.place_id || placeId,
    address: result.formatted_address || "",
    commune: extractCommuneFromLegacyComponents(result.address_components || []),
    location: result.geometry?.location || null
  };
}

async function placeDetails(req, res, settings) {
  if (!settings.googleMapsApiKey) return sendError(res, 400, "Google Maps API no configurada");

  const url = new URL(req.url, `http://${req.headers.host}`);
  const placeId = String(url.searchParams.get("placeId") || "").trim();
  if (!placeId) return sendError(res, 400, "Falta placeId");

  try {
    return sendJson(res, 200, await newPlaceDetails(placeId, settings.googleMapsApiKey));
  } catch (newPlacesError) {
    try {
      return sendJson(res, 200, await legacyPlaceDetails(placeId, settings.googleMapsApiKey));
    } catch (legacyError) {
      return sendError(res, 502, legacyError.message || newPlacesError.message);
    }
  }
}

async function testGoogleMaps(req, res, settings) {
  if (!isAuthed(req, settings)) return sendError(res, 401, "No autorizado");
  if (!settings.googleMapsApiKey) return sendError(res, 400, "Google Maps API no configurada");

  try {
    const suggestions = await newPlacesAutocomplete("Av Providencia 1200 Santiago", settings.googleMapsApiKey);
    return sendJson(res, 200, {
      ok: true,
      source: "Places API nueva",
      count: suggestions.length,
      sample: suggestions[0]?.text || ""
    });
  } catch (newPlacesError) {
    try {
      const suggestions = await legacyPlacesAutocomplete("Av Providencia 1200 Santiago", settings.googleMapsApiKey);
      return sendJson(res, 200, {
        ok: true,
        source: "Places API legacy",
        count: suggestions.length,
        sample: suggestions[0]?.text || ""
      });
    } catch (legacyError) {
      return sendError(res, 502, legacyError.message || newPlacesError.message);
    }
  }
}

async function handleApi(req, res, settings) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/public-config") {
    return sendJson(res, 200, publicSettings(settings));
  }

  if (req.method === "GET" && url.pathname === "/api/places/autocomplete") {
    return placesAutocomplete(req, res, settings);
  }

  if (req.method === "GET" && url.pathname === "/api/places/details") {
    return placeDetails(req, res, settings);
  }

  if (req.method === "POST" && url.pathname === "/api/admin/test-google-maps") {
    return testGoogleMaps(req, res, settings);
  }

  if (req.method === "GET" && url.pathname === "/api/admin/status") {
    return sendJson(res, 200, {
      setupRequired: !settings.adminPasswordHash,
      authenticated: isAuthed(req, settings)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/setup") {
    if (settings.adminPasswordHash) return sendError(res, 409, "El administrador ya fue configurado");
    const body = await readJson(req);
    if (!body.password || String(body.password).length < 8) {
      return sendError(res, 400, "La clave debe tener al menos 8 caracteres");
    }
    const { hash, salt } = hashPassword(String(body.password));
    const savedSettings = await writeSettings({ ...settings, adminPasswordHash: hash, adminPasswordSalt: salt });
    createSession(res, savedSettings);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const body = await readJson(req);
    if (!verifyPassword(String(body.password || ""), settings)) {
      return sendError(res, 401, "Clave incorrecta");
    }
    createSession(res, settings);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/logout") {
    clearSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/admin/settings") {
    if (!isAuthed(req, settings)) return sendError(res, 401, "No autorizado");

    if (req.method === "GET") return sendJson(res, 200, adminSettings(settings));

    if (req.method === "POST") {
      const body = await readJson(req);
      const nextSettings = {
        ...settings,
        businessName: String(body.businessName || settings.businessName).trim(),
        whatsapp: String(body.whatsapp || "").replace(/[^\d]/g, ""),
        email: String(body.email || "").trim()
      };

      if (String(body.googleMapsApiKey || "").trim()) {
        nextSettings.googleMapsApiKey = String(body.googleMapsApiKey).trim();
      }

      if (!nextSettings.businessName || !nextSettings.whatsapp) {
        return sendError(res, 400, "Nombre del negocio y WhatsApp son obligatorios");
      }

      await writeSettings(nextSettings);
      return sendJson(res, 200, adminSettings(nextSettings));
    }
  }

  sendError(res, 404, "Endpoint no encontrado");
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  let route = decoded === "/" ? "/index.html" : decoded === "/admin" ? "/admin.html" : decoded;
  if (!path.extname(route)) route = `${route}.html`;
  const filePath = path.normalize(path.join(ROOT, route));
  if (!filePath.startsWith(ROOT) || filePath.includes(`${path.sep}data${path.sep}`)) return null;
  return filePath;
}

async function serveStatic(req, res) {
  const filePath = safeStaticPath(req.url);
  if (!filePath) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("No es archivo");
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=86400"
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("No encontrado");
  }
}

async function app(req, res) {
  try {
    const settings = await readSettings();
    if (req.url.startsWith("/api/")) return await handleApi(req, res, settings);
    return await serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Error interno");
  }
}

if (require.main === module) {
  const server = http.createServer(app);
  server.listen(PORT, () => {
    console.log(`Cotizador listo en http://127.0.0.1:${PORT}`);
  });
}

module.exports = app;
