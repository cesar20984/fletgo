const fsp = require("fs/promises");
const path = require("path");
const { neon } = require("@neondatabase/serverless");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "app.db");
const LEGACY_SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const DEFAULT_SETTINGS = {
  businessName: "Cotiza Fletes Chile",
  whatsapp: "56900000000",
  email: "cotizaciones@tu-dominio.cl",
  googleMapsApiKey: "",
  adminPasswordHash: "",
  adminPasswordSalt: ""
};

let neonSql;
let neonReady = false;
let sqliteDb;

async function readLegacySettings() {
  try {
    const raw = await fsp.readFile(LEGACY_SETTINGS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function ensureNeon() {
  if (!process.env.DATABASE_URL) return null;
  if (!neonSql) neonSql = neon(process.env.DATABASE_URL);

  if (!neonReady) {
    await neonSql`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;

    const rows = await neonSql`SELECT COUNT(*)::int AS total FROM app_settings`;
    if (rows[0].total === 0) await writeSettingsToNeon(DEFAULT_SETTINGS);
    neonReady = true;
  }

  return neonSql;
}

function assertWritableLocalDatabase() {
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL no esta configurado. En Vercel debes conectar Neon y agregar DATABASE_URL.");
  }
}

async function writeSettingsToNeon(settings) {
  const sql = neonSql || neon(process.env.DATABASE_URL);
  for (const [key, value] of Object.entries({ ...DEFAULT_SETTINGS, ...settings })) {
    await sql`
      INSERT INTO app_settings (key, value)
      VALUES (${key}, ${String(value || "")})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }
}

async function ensureSqlite() {
  assertWritableLocalDatabase();
  if (sqliteDb) return sqliteDb;

  await fsp.mkdir(DATA_DIR, { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  sqliteDb = new DatabaseSync(DB_FILE);
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const count = sqliteDb.prepare("SELECT COUNT(*) AS total FROM app_settings").get().total;
  if (count === 0) {
    const legacy = await readLegacySettings();
    writeSettingsToSqlite({ ...DEFAULT_SETTINGS, ...(legacy || {}) });
    if (legacy) await fsp.unlink(LEGACY_SETTINGS_FILE).catch(() => {});
  }

  return sqliteDb;
}

function writeSettingsToSqlite(settings) {
  const statement = sqliteDb.prepare(`
    INSERT INTO app_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  for (const [key, value] of Object.entries({ ...DEFAULT_SETTINGS, ...settings })) {
    statement.run(key, String(value || ""));
  }
}

async function readSettings() {
  const sql = await ensureNeon();
  if (sql) {
    const rows = await sql`SELECT key, value FROM app_settings`;
    const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  const database = await ensureSqlite();
  const rows = database.prepare("SELECT key, value FROM app_settings").all();
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function writeSettings(settings) {
  const sql = await ensureNeon();
  if (sql) {
    await writeSettingsToNeon(settings);
    return readSettings();
  }

  await ensureSqlite();
  writeSettingsToSqlite(settings);
  return readSettings();
}

module.exports = {
  DEFAULT_SETTINGS,
  readSettings,
  writeSettings
};
