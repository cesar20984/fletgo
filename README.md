# Cotizador de Fletes Chile

Sitio rapido para cotizar fletes, transporte local y mudanzas en Chile. Incluye panel privado y proxy de Google Places para que la API key no quede expuesta al publico.

## Antes de publicar

Actualiza estos valores:

- El dominio canonico ya esta configurado como `https://fletgo.cl/`. Si cambia en el futuro, actualiza canonical, Open Graph, schema, `robots.txt` y `sitemap.xml`.
- `robots.txt`: reemplaza la URL del sitemap.
- `sitemap.xml`: reemplaza la URL principal y actualiza `lastmod`.

Luego entra al panel `/admin` para configurar:

- Nombre del negocio.
- WhatsApp en formato internacional sin `+`, por ejemplo `56912345678`.
- Correo que recibira solicitudes.
- Google Maps API key.

En produccion, la Google Maps API key y la configuracion del panel se guardan en Neon/PostgreSQL usando la variable `DATABASE_URL`. En local, si no existe `DATABASE_URL`, el servidor usa SQLite en `data/app.db` como respaldo de desarrollo. La API key no se inserta en el HTML ni en el JavaScript publico.

## Vercel + Neon

Antes de desplegar en Vercel:

- Crea una base de datos en Neon.
- Copia el connection string de Neon.
- En Vercel, agrega `DATABASE_URL` con ese connection string.
- En Vercel, agrega `ADMIN_SESSION_SECRET` con un valor largo y aleatorio para firmar la sesion del panel.
- Despliega el repositorio. Al abrir `/admin`, el servidor creara automaticamente la tabla `app_settings` si no existe.

El archivo `vercel.json` enruta `/api/*` y las paginas limpias al handler serverless `server.js`.

## Sitemap

El sitemap se genera automaticamente escaneando los archivos `public/**/*.html`.

```powershell
npm run sitemap
```

El script excluye paginas con `meta name="robots" content="noindex"`, como `/admin`, y escribe `public/sitemap.xml` y `public/robots.txt`. Para cambiar el dominio usado en el sitemap, define `SITE_URL`, por ejemplo `https://fletgo.cl`.

## Google Maps

En Google Cloud necesitas:

- Un proyecto con facturacion activa.
- Una API key.
- La API `Places API (New)` habilitada. El servidor tambien intenta usar la API legacy `Places API` como respaldo.
- Si restringes la key por API, permite Places.
- Si restringes por origen HTTP, recuerda que esta key la usa el servidor, no el navegador. Para produccion suele convenir restringirla por IP del servidor cuando tu hosting lo permita.

Despues de guardar la key en `/admin`, usa el boton `Probar Google Maps`. Si funciona, el formulario publico mostrara sugerencias al escribir 3 o mas caracteres en origen o destino y rellenara la comuna al seleccionar una direccion cuando Google entregue ese dato.

## Vista local

Levanta el servidor:

```powershell
npm start
```

Luego entra a `http://127.0.0.1:4174`.

El panel queda en `http://127.0.0.1:4174/admin`.
