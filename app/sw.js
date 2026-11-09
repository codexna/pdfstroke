// Service worker: funcionamiento sin conexión y recepción de PDFs compartidos (Android).
const VERSION = 'v20';
const APP_CACHE = 'editorpdf-' + VERSION;
const SHARED_CACHE = 'editorpdf-shared';
const OCR_CACHE = 'editorpdf-ocr-1'; // modelos del OCR del navegador (grandes): no se borran al actualizar la app
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css',
  'js/app.js', 'js/state.js', 'js/viewer.js', 'js/objects.js', 'js/textlayer.js', 'js/exporter.js', 'js/textremove.js', 'js/pdftext.js',
  'js/thumbs.js', 'js/signature.js', 'js/preview.js', 'js/paint.js', 'js/word.js', 'js/pro.js', 'js/docx.js', 'js/convert.js', 'js/ocr.js', 'js/i18n.js', 'js/firma-digital.js', ...['en', 'pt', 'fr', 'de', 'it'].map((l) => `js/lang/${l}.js`),
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/pdf-lib.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/fonts/fonts.css',
  ...['arimo', 'tinos', 'cousine'].flatMap((f) => ['400-normal', '400-italic', '700-normal', '700-italic']
    .map((v) => `vendor/fonts/${f}-latin-${v}.woff2`)),
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== APP_CACHE && key !== SHARED_CACHE && key !== OCR_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // "Compartir con PDF Stroke" desde otra app
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const data = await req.formData();
        const file = data.get('file');
        if (file) {
          const cache = await caches.open(SHARED_CACHE);
          await cache.put('shared-file', new Response(file, {
            headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(file.name || 'compartido.pdf') },
          }));
        }
      } catch (err) { /* se abre la app igualmente */ }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET') return;

  // Librerías y modelos del OCR: primero caché (no cambian)
  const ocr = url.pathname.includes('/ocr-web/');
  if (ocr || url.pathname.includes('/vendor/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(ocr ? OCR_CACHE : APP_CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // Resto de la app: primero red (para recibir actualizaciones), caché si no hay conexión
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(APP_CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(async () => (await caches.match(req, { ignoreSearch: req.mode === 'navigate' })) ||
    (req.mode === 'navigate' ? caches.match('index.html') : Response.error())));
});
