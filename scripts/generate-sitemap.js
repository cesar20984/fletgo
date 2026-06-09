const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const SITE_URL = (process.env.SITE_URL || "https://fletgo.cl").replace(/\/+$/, "");

function walkHtmlFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkHtmlFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith(".html")) return [fullPath];
    return [];
  });
}

function htmlPathToUrl(filePath) {
  const relative = path.relative(PUBLIC_DIR, filePath).replace(/\\/g, "/");
  if (relative === "index.html") return "/";
  return `/${relative.replace(/\/index\.html$/, "/").replace(/\.html$/, "")}`;
}

function isIndexable(filePath) {
  const html = fs.readFileSync(filePath, "utf8");
  const robotsMeta = html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i);
  return !robotsMeta || !robotsMeta[1].toLowerCase().includes("noindex");
}

function priorityFor(url) {
  if (url === "/") return "1.0";
  if (url.includes("politica") || url.includes("aviso-legal") || url.includes("terminos")) return "0.4";
  return "0.7";
}

function frequencyFor(url) {
  if (url === "/") return "weekly";
  if (url.includes("politica") || url.includes("aviso-legal") || url.includes("terminos")) return "monthly";
  return "weekly";
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const urls = walkHtmlFiles(PUBLIC_DIR)
  .filter(isIndexable)
  .map((filePath) => {
    const url = htmlPathToUrl(filePath);
    const lastmod = fs.statSync(filePath).mtime.toISOString().slice(0, 10);
    return { url, lastmod };
  })
  .sort((a, b) => {
    if (a.url === "/") return -1;
    if (b.url === "/") return 1;
    return a.url.localeCompare(b.url);
  });

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(({ url, lastmod }) => `  <url>
    <loc>${xmlEscape(`${SITE_URL}${url}`)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${frequencyFor(url)}</changefreq>
    <priority>${priorityFor(url)}</priority>
  </url>`).join("\n")}
</urlset>
`;

const robots = `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;

fs.writeFileSync(path.join(PUBLIC_DIR, "sitemap.xml"), sitemap);
fs.writeFileSync(path.join(PUBLIC_DIR, "robots.txt"), robots);
fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap);
fs.writeFileSync(path.join(ROOT, "robots.txt"), robots);

console.log(`Generated sitemap with ${urls.length} URLs for ${SITE_URL}`);
