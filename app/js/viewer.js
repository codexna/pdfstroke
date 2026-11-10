// Vista de páginas: maquetación, renderizado con pdf.js, zoom y coordenadas.
import { state, on, emit, findPage } from './state.js';
import { renderObjects, onPagePointerDown, onPageClick } from './objects.js';
import { renderTextBoxes, getLines } from './textlayer.js';
import { hiderSpecs, getPreview, specsKey } from './preview.js';

export const viewerEl = document.getElementById('viewer');
const pagesEl = document.getElementById('pages');
const pageEls = new Map(); // uid -> { wrap, inner, canvas, textLayer, objLayer, renderedScale, task }
const visible = new Set();
const MAX_CANVAS_PX = /Android|iPhone|iPad/i.test(navigator.userAgent) ? 8e6 : 16e6;

export const getEls = (uid) => pageEls.get(uid);

/** Dimensiones mostradas (tras la rotación del usuario), en puntos. */
export function shownSize(p) {
  return p.rotation % 180 ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const uid = e.target.dataset.uid;
    if (e.isIntersecting) { visible.add(uid); showPreview(uid); }
    else { visible.delete(uid); releaseCanvas(uid); }
  }
  scheduleRender(30);
}, { root: viewerEl, rootMargin: '900px 0px' });

// ---------- Vistas previas ligeras ----------
// Cada página tiene además una imagen pequeña que se prepara por adelantado (varias pantallas antes de llegar a ella)
// y se guarda: al desplazarse, la página se ve al momento con ella mientras se dibuja la versión nítida.
const PREVIEW_W = 360; // píxeles de ancho
const PREVIEW_MAX = 60; // páginas guardadas
const previews = new Map(); // "origen:página" -> ImageBitmap | canvas (orden = uso reciente)
const near = new Set(); // páginas cerca de la vista (para preparar su vista previa)
const previewKey = (p) => p.src + ':' + p.index;
let previewBusy = false;

const nearIo = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) near.add(e.target.dataset.uid); else near.delete(e.target.dataset.uid);
  }
  schedulePreviews();
}, { root: viewerEl, rootMargin: '300% 0px' });

let previewTimer = 0;
function schedulePreviews(delay = 60) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(makePreviews, delay);
}

/** Pone la vista previa en una página que todavía no está dibujada (al instante, sin esperar). */
function showPreview(uid) {
  const els = pageEls.get(uid);
  const p = findPage(uid);
  if (!els || !p || p.src == null || els.renderedScale) return;
  const k = previewKey(p);
  const img = previews.get(k);
  if (!img) return;
  previews.delete(k);
  previews.set(k, img); // usada ahora: la más reciente
  if (els.canvas.width !== img.width || els.canvas.height !== img.height) {
    els.canvas.width = img.width;
    els.canvas.height = img.height;
  }
  els.canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
}

async function makePreviews() {
  if (previewBusy) return;
  previewBusy = true;
  try {
    // Primero las más cercanas a lo que se ve
    const order = [...near].sort((a, b) => distanceToCenter(a) - distanceToCenter(b));
    for (const uid of order) {
      const p = findPage(uid);
      if (!p || p.src == null || previews.has(previewKey(p))) continue;
      // Lo que se ve tiene prioridad: si hay páginas visibles sin dibujar, se espera
      if ([...visible].some((v) => { const e = pageEls.get(v); return e && !e.renderedScale; })) { schedulePreviews(250); return; }
      try {
        const page = await state.sources.get(p.src).pdf.getPage(p.index + 1);
        const c = document.createElement('canvas');
        c.width = PREVIEW_W;
        c.height = Math.max(1, Math.round((PREVIEW_W * p.h) / p.w));
        const viewport = page.getViewport({ scale: c.width / p.w });
        await page.render({ canvasContext: c.getContext('2d'), viewport }).promise;
        const img = window.createImageBitmap ? await createImageBitmap(c) : c;
        previews.set(previewKey(p), img);
        while (previews.size > PREVIEW_MAX) {
          const [old, oimg] = previews.entries().next().value;
          previews.delete(old);
          oimg.close?.();
        }
        showPreview(uid);
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') console.warn('Vista previa no disponible', err);
      }
    }
  } finally {
    previewBusy = false;
  }
}

function createPageEls(p) {
  const wrap = document.createElement('div');
  wrap.className = 'page';
  wrap.dataset.uid = p.uid;
  const inner = document.createElement('div');
  inner.className = 'page-inner';
  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  const textLayer = document.createElement('div');
  textLayer.className = 'text-layer';
  const objLayer = document.createElement('div');
  objLayer.className = 'obj-layer';
  // La capa recorta lo que sale de la página; el navegador no debe desplazarla para seguir al cursor de escritura
  objLayer.addEventListener('scroll', () => { objLayer.scrollTop = 0; objLayer.scrollLeft = 0; });
  // La selección va en su propia capa, que puede salirse de la página (para alcanzar tiradores junto al borde)
  const selLayer = document.createElement('div');
  selLayer.className = 'sel-layer';
  inner.append(canvas, textLayer, objLayer, selLayer);
  wrap.append(inner);
  wrap.addEventListener('pointerdown', (e) => onPagePointerDown(e, wrap.dataset.uid));
  wrap.addEventListener('click', (e) => onPageClick(e, wrap.dataset.uid));
  // Pulsar un tirador no debe quitar el foco al texto que se está editando
  wrap.addEventListener('mousedown', (e) => { if (e.target.closest('.handle, .grip')) e.preventDefault(); });
  const els = {
    wrap, inner, canvas, textLayer, objLayer, selLayer, renderedScale: 0, task: null, textKey: null,
    patches: [], patchSet: null, failed: new Set(), // zonas que muestran la página modificada (ver preparePatches)
  };
  io.observe(wrap);
  nearIo.observe(wrap);
  return els;
}

/** Crea o reordena los elementos de página según state.pages (reutiliza los existentes). */
export function buildPages() {
  const keep = new Set(state.pages.map((p) => p.uid));
  for (const [uid, els] of pageEls) {
    if (!keep.has(uid)) {
      io.unobserve(els.wrap);
      nearIo.unobserve(els.wrap);
      els.task?.cancel();
      els.wrap.remove();
      pageEls.delete(uid);
      visible.delete(uid);
    }
  }
  for (const p of state.pages) {
    let els = pageEls.get(p.uid);
    if (!els) { els = createPageEls(p); pageEls.set(p.uid, els); }
    pagesEl.appendChild(els.wrap); // appendChild mueve el nodo si ya existía
    els.inner.style.width = p.w + 'px';
    els.inner.style.height = p.h + 'px';
    layoutPage(p, els);
    renderObjects(p);
  }
  scheduleRender(10);
  updateCurrentPage();
}

export function layoutPage(p, els = pageEls.get(p.uid)) {
  if (!els) return;
  const z = state.zoom;
  const { w, h } = shownSize(p);
  els.wrap.style.width = w * z + 'px';
  els.wrap.style.height = h * z + 'px';
  const r = p.rotation;
  let tx = 0, ty = 0;
  if (r === 90) tx = p.h * z;
  else if (r === 180) { tx = p.w * z; ty = p.h * z; }
  else if (r === 270) ty = p.w * z;
  els.inner.style.transform = `translate(${tx}px,${ty}px) rotate(${r}deg) scale(${z})`;
  els.inner.style.setProperty('--z', z);
}

/** Convierte coordenadas de pantalla a coordenadas de página (puntos, sin rotación del usuario). */
export function toLocal(p, clientX, clientY) {
  const els = pageEls.get(p.uid);
  const rect = els.wrap.getBoundingClientRect();
  const sx = (clientX - rect.left) / state.zoom;
  const sy = (clientY - rect.top) / state.zoom;
  switch (p.rotation) {
    case 90: return { x: sy, y: p.h - sx };
    case 180: return { x: p.w - sx, y: p.h - sy };
    case 270: return { x: p.w - sy, y: sx };
    default: return { x: sx, y: sy };
  }
}

// ---------- Renderizado ----------
let renderTimer = 0;
export function scheduleRender(delay = 150) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderVisible, delay);
}

async function renderVisible() {
  // Primero la página actual, luego el resto de visibles
  const order = [...visible].sort((a, b) => distanceToCenter(a) - distanceToCenter(b));
  for (const uid of order) showPreview(uid); // mientras, la vista previa (si ya está hecha)
  for (const uid of order) {
    const p = findPage(uid);
    if (!p) continue;
    try { await renderPage(p); } catch (err) { console.error('Error al renderizar', err); }
    // (mientras se dibujaba, deshacer/rehacer puede haber sustituido la página por otra con el mismo uid)
    const cur = findPage(uid);
    if (!cur) continue;
    if (state.tool === 'edittext') renderTextBoxes(cur);
    else if (state.tool === 'highlight' || state.tool === 'fill') getLines(cur);
  }
}

function distanceToCenter(uid) {
  const els = pageEls.get(uid);
  if (!els) return Infinity;
  const r = els.wrap.getBoundingClientRect();
  const v = viewerEl.getBoundingClientRect();
  return Math.abs(r.top + r.height / 2 - (v.top + v.height / 2));
}

function targetScale(p) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  let scale = state.zoom * dpr;
  if (p.w * p.h * scale * scale > MAX_CANVAS_PX) scale = Math.sqrt(MAX_CANVAS_PX / (p.w * p.h));
  return scale;
}

async function renderPage(p) {
  const els = pageEls.get(p.uid);
  if (!els) return;
  const scale = targetScale(p);
  if (Math.abs(els.renderedScale - scale) < 0.001) return;
  if (els.pendingScale === scale) return; // ya se está dibujando a esta escala
  els.task?.cancel();
  els.pendingScale = scale;
  try {
    const c = document.createElement('canvas');
    c.className = 'page-canvas';
    c.width = Math.max(1, Math.floor(p.w * scale));
    c.height = Math.max(1, Math.floor(p.h * scale));
    const ctx = c.getContext('2d', { willReadFrequently: true });

    if (p.src == null) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
    } else {
      const src = state.sources.get(p.src);
      const page = await src.pdf.getPage(p.index + 1);
      const viewport = page.getViewport({ scale: c.width / p.w });
      const task = page.render({ canvasContext: ctx, viewport });
      els.task = task;
      try {
        await task.promise;
      } catch (err) {
        if (err?.name === 'RenderingCancelledException') return;
        throw err;
      } finally {
        if (els.task === task) els.task = null;
      }
    }
    // Las zonas con texto original editado se ven ya como en la página modificada
    const q = findPage(p.uid) || p;
    const specs = hiderSpecs(q);
    let patches = [], patchSet = null, failed = new Set();
    if (specs.length) {
      try {
        const prepared = await preparePatches(q, c.width, c.height, specs);
        patches = applyPatches(c, prepared.list);
        failed = prepared.failed;
        patchSet = specsKey(specs);
      } catch (err) {
        console.warn('No se pudieron dibujar las zonas modificadas', err);
      }
    }
    // (si mientras tanto la página ha salido de la vista, su lienzo se ha liberado y debe quedarse así)
    if (pageEls.get(p.uid) !== els || els.pendingScale !== scale || !visible.has(p.uid)) return;
    // Se copia el resultado en el lienzo visible en lugar de sustituirlo: si se sustituyera, un gesto táctil que
    // empezó sobre él (p. ej. pellizcar para hacer zoom) dejaría de llegar a la página
    const dst = els.canvas;
    dst.width = c.width;
    dst.height = c.height;
    dst.getContext('2d', { willReadFrequently: true }).drawImage(c, 0, 0);
    els.renderedScale = scale;
    if (p.src != null && !previews.has(previewKey(p))) schedulePreviews(200);
    els.patches = patches;
    els.patchSet = patchSet;
    els.failed = failed;
    // Por si las líneas editadas han cambiado mientras tanto (también la propia página, al deshacer o rehacer)
    const cur = findPage(p.uid);
    if (cur) refreshPatches(cur);
  } finally {
    if (els.pendingScale === scale) els.pendingScale = 0;
  }
}

function releaseCanvas(uid) {
  const els = pageEls.get(uid);
  if (!els || !els.renderedScale) return;
  els.task?.cancel();
  els.canvas.width = 0;
  els.canvas.height = 0;
  els.renderedScale = 0;
  els.patches = [];
  els.patchSet = null;
  els.failed = new Set();
  showPreview(uid); // queda la vista previa ligera (si la hay), que ocupa muy poco
}

// ---------- Zonas modificadas ----------
/**
 * Dibuja (fuera de pantalla) las zonas de la página modificada que corresponden a cada línea o anotación editada,
 * con la misma escala y la misma rejilla de píxeles que el lienzo de la página original.
 */
async function preparePatches(p, cw, ch, specs) {
  const pv = await getPreview(p, specs);
  // Las zonas cuyo texto no se pudo quitar del todo se quedan tapadas
  if (!pv.page) return { list: [], failed: new Set(specs.map((s) => s.key)) };
  const k = cw / p.w;
  const regions = [];
  const failed = new Set(pv.failed);
  for (const s of specs) {
    if (failed.has(s.key)) continue;
    const x0 = Math.max(0, Math.floor(s.rect.x * k)), y0 = Math.max(0, Math.floor(s.rect.y * k));
    const x1 = Math.min(cw, Math.ceil((s.rect.x + s.rect.w) * k)), y1 = Math.min(ch, Math.ceil((s.rect.y + s.rect.h) * k));
    if (x1 > x0 && y1 > y0) regions.push({ s, x0, y0, x1, y1 });
    else failed.add(s.key); // fuera de la página: no hay nada que mostrar (y no se vuelve a intentar)
  }
  if (!regions.length) return { list: [], failed };
  // Se dibuja sólo el trozo de página que hace falta (desplazado un número entero de píxeles), con algo de margen:
  // en el borde mismo del lienzo pdf.js no pinta las letras que apenas asoman
  const M = 8;
  const ux0 = Math.min(...regions.map((r) => r.x0)) - M, uy0 = Math.min(...regions.map((r) => r.y0)) - M;
  const ux1 = Math.max(...regions.map((r) => r.x1)) + M, uy1 = Math.max(...regions.map((r) => r.y1)) + M;
  const tmp = document.createElement('canvas');
  tmp.width = ux1 - ux0;
  tmp.height = uy1 - uy0;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  await pv.page.render({ canvasContext: tctx, viewport: pv.page.getViewport({ scale: k, offsetX: -ux0, offsetY: -uy0 }) }).promise;
  const list = regions.map(({ s, x0, y0, x1, y1 }) => ({
    id: s.id, key: s.key, zone: s.zone, x: x0, y: y0, img: tctx.getImageData(x0 - ux0, y0 - uy0, x1 - x0, y1 - y0),
  }));
  return { list, failed };
}

/** Pone las zonas preparadas en un lienzo, guardando lo que había debajo para poder quitarlas al momento. */
function applyPatches(canvas, prepared) {
  if (!prepared?.length) return [];
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  for (const pt of prepared) {
    pt.base = ctx.getImageData(pt.x, pt.y, pt.img.width, pt.img.height);
    ctx.putImageData(pt.img, pt.x, pt.y);
  }
  return prepared;
}

/** Quita del lienzo visible todas las zonas modificadas (en orden inverso, por si se solapan). */
function removePatches(els) {
  const ctx = els.canvas.getContext('2d', { willReadFrequently: true });
  for (const pt of [...els.patches].reverse()) ctx.putImageData(pt.base, pt.x, pt.y);
}

const patchTimers = new Map();
const contains = (a, b) => a.x <= b.x + 0.01 && a.y <= b.y + 0.01 && a.x + a.w >= b.x + b.w - 0.01 && a.y + a.h >= b.y + b.h - 0.01;

/**
 * Parte de una zona que crece hacia abajo (al ocupar el texto más líneas) que aún no se ve modificada: es lo único
 * que hay que tapar mientras se prepara. Si ha crecido de otra forma, se tapa entera.
 */
function grownPart(z, old) {
  const sameSides = Math.abs(z.x - old.x) < 0.01 && Math.abs(z.w - old.w) < 0.01 && Math.abs(z.y - old.y) < 0.01;
  if (!sameSides) return z;
  const top = old.y + old.h;
  return z.y + z.h > top + 0.01 ? { x: z.x, y: top, w: z.w, h: z.y + z.h - top } : null;
}

/**
 * Tras abrir, cambiar o cerrar líneas editadas: lo que ya no está editado vuelve a verse al momento como en el
 * original, y la página modificada para lo nuevo se prepara en segundo plano (mientras, lo tapa su tapa provisional).
 * Avisa con el evento 'patches' de qué tapas sobran y qué parte de las demás hace falta.
 */
export function refreshPatches(p) {
  const els = pageEls.get(p.uid);
  if (!els) return;
  const specs = hiderSpecs(p);
  const byId = new Map(specs.map((s) => [s.id, s]));
  // Una zona sigue valiendo si su objeto sigue ahí con la misma zona, o con una zona que sólo ha crecido: lo ya
  // quitado sigue quitado
  const valid = (pt) => {
    const s = byId.get(pt.id);
    return !!s && (s.key === pt.key || (!!s.zone && !!pt.zone && contains(s.zone, pt.zone)));
  };
  if (els.patches.some((pt) => !valid(pt))) {
    removePatches(els);
    els.patches = applyPatches(els.canvas, els.patches.filter(valid));
    els.patchSet = null; // hay que volver a preparar el conjunto (puede ser el mismo con otros objetos)
  }
  const set = specs.length ? specsKey(specs) : null;
  if (!set) els.patchSet = null;
  const status = new Map();
  let missing = false;
  for (const s of specs) {
    const pt = els.patches.find((q) => q.id === s.id);
    if (pt?.key === s.key) { status.set(s.id, { hidden: true }); continue; }
    const rect = pt ? grownPart(s.zone, pt.zone) : s.zone || null;
    status.set(s.id, rect || !s.zone ? { rect } : { hidden: true });
    // Las que ya se sabe que no se pueden quitar se quedan tapadas sin volver a intentarlo
    if (!(els.patchSet === set && els.failed?.has(s.key))) missing = true;
  }
  emit('patches', { p, status });
  if (set && els.renderedScale && (set !== els.patchSet || missing)) {
    if (missing) els.patchSet = null;
    // Una línea recién abierta se prepara enseguida; los cambios mientras se escribe, con algo de calma
    schedulePatches(p, els.patches.length ? 120 : 40);
  }
}

function schedulePatches(p, delay) {
  clearTimeout(patchTimers.get(p.uid));
  patchTimers.set(p.uid, setTimeout(() => {
    patchTimers.delete(p.uid);
    updatePatches(p).catch((err) => console.warn('No se pudieron actualizar las zonas modificadas', err));
  }, delay));
}

async function updatePatches(p) {
  p = findPage(p.uid) || p;
  const els = pageEls.get(p.uid);
  if (!els || !els.renderedScale || els.pendingScale || !state.pages.includes(p)) return;
  const specs = hiderSpecs(p);
  const set = specs.length ? specsKey(specs) : null;
  if (!set || set === els.patchSet) return;
  const { width: cw, height: ch } = els.canvas;
  const prepared = await preparePatches(p, cw, ch, specs);
  // Si mientras tanto la página se ha vuelto a dibujar, se ha sustituido (deshacer/rehacer) o han cambiado sus líneas
  // editadas, se vuelve a empezar con lo que haya ahora
  if (pageEls.get(p.uid) !== els || els.pendingScale || els.canvas.width !== cw || els.canvas.height !== ch) return;
  const cur = findPage(p.uid);
  if (cur !== p || specsKey(hiderSpecs(p)) !== set) { if (cur) refreshPatches(cur); return; }
  removePatches(els);
  els.patches = applyPatches(els.canvas, prepared.list);
  els.patchSet = set;
  els.failed = prepared.failed;
  refreshPatches(p);
}

/** Re-renderiza una página (por ejemplo, tras cargar fuentes o cambiar el documento). */
export function invalidatePage(uid) {
  const els = pageEls.get(uid);
  if (els) els.renderedScale = 0;
  scheduleRender(10);
}

// ---------- Zoom ----------
/** Posición en pantalla de un punto de una página (inverso de toLocal). */
function toClient(p, x, y) {
  const rect = pageEls.get(p.uid).wrap.getBoundingClientRect();
  const z = state.zoom;
  let sx = x * z, sy = y * z;
  if (p.rotation === 90) { sx = (p.h - y) * z; sy = x * z; }
  else if (p.rotation === 180) { sx = (p.w - x) * z; sy = (p.h - y) * z; }
  else if (p.rotation === 270) { sx = y * z; sy = (p.w - x) * z; }
  return { x: rect.left + sx, y: rect.top + sy };
}

/** Página bajo un punto de la pantalla (o la más cercana en vertical). */
function pageAtClient(x, y) {
  let best = null, bestD = Infinity;
  for (const p of state.pages) {
    const els = pageEls.get(p.uid);
    if (!els) continue;
    const r = els.wrap.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < bestD) { bestD = d; best = p; }
    if (d === 0 && x >= r.left && x <= r.right) return p;
  }
  return best;
}

export function setZoom(z, anchor) {
  z = Math.min(6, Math.max(0.2, z));
  const old = state.zoom;
  if (Math.abs(z - old) < 1e-4) return;
  const vr = viewerEl.getBoundingClientRect();
  const ax = anchor ? anchor.x : vr.left + vr.width / 2;
  const ay = anchor ? anchor.y : vr.top + vr.height / 2;
  // El punto de la página que está bajo el ancla (el puntero o el centro) se queda donde está
  const p = pageAtClient(ax, ay);
  const local = p && toLocal(p, ax, ay);
  state.zoom = z;
  for (const q of state.pages) layoutPage(q);
  if (p) {
    const after = toClient(p, local.x, local.y);
    viewerEl.scrollLeft += after.x - ax;
    viewerEl.scrollTop += after.y - ay;
  }
  emit('zoom');
  scheduleRender(180);
}

export function fitWidth(max = 1.5) {
  if (!state.pages.length) return;
  const maxW = Math.max(...state.pages.map((p) => shownSize(p).w));
  const avail = viewerEl.clientWidth - (viewerEl.clientWidth < 700 ? 16 : 48);
  setZoom(Math.min(max, avail / maxW));
}

// ---------- Navegación ----------
let currentUid = null;
export const currentPageUid = () => currentUid || state.pages[0]?.uid;

export function updateCurrentPage() {
  const v = viewerEl.getBoundingClientRect();
  const mid = v.top + v.height / 3;
  let best = null, bestD = Infinity;
  for (const p of state.pages) {
    const els = pageEls.get(p.uid);
    if (!els) continue;
    const r = els.wrap.getBoundingClientRect();
    const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
    if (d < bestD) { bestD = d; best = p.uid; }
    if (d === 0) break;
  }
  // Al final del documento, la página actual es la última (aunque sea corta y no llegue a la línea de referencia)
  if (viewerEl.scrollTop > 0 && viewerEl.scrollTop + viewerEl.clientHeight >= viewerEl.scrollHeight - 2 && state.pages.length) {
    best = state.pages[state.pages.length - 1].uid;
  }
  if (best !== currentUid) {
    currentUid = best;
    emit('currentpage', best);
  }
}

export function scrollToPage(uid, offsetY = 0, smooth = false) {
  const els = pageEls.get(uid);
  if (!els) return;
  const top = els.wrap.offsetTop - 12 + offsetY;
  viewerEl.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
}

/** Desplaza la vista para mostrar un punto de una página (en coordenadas de página). */
export function scrollToPoint(p, x, y) {
  const els = pageEls.get(p.uid);
  if (!els) return;
  const rect = els.wrap.getBoundingClientRect();
  const vr = viewerEl.getBoundingClientRect();
  const z = state.zoom;
  let sx = x * z, sy = y * z;
  if (p.rotation === 90) { sx = (p.h - y) * z; sy = x * z; }
  else if (p.rotation === 180) { sx = (p.w - x) * z; sy = (p.h - y) * z; }
  else if (p.rotation === 270) { sx = y * z; sy = (p.w - x) * z; }
  viewerEl.scrollTo({
    top: viewerEl.scrollTop + rect.top - vr.top + sy - vr.height / 3,
    left: viewerEl.scrollLeft + rect.left - vr.left + sx - vr.width / 2,
    behavior: 'smooth',
  });
}

let scrollRaf = 0;
viewerEl.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateCurrentPage(); });
}, { passive: true });

// Ctrl + rueda = zoom
viewerEl.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !state.pages.length) return;
  e.preventDefault();
  setZoom(state.zoom * Math.exp(-e.deltaY * 0.0025), { x: e.clientX, y: e.clientY });
}, { passive: false });

// Pellizcar para hacer zoom (y arrastrar con dos dedos cuando una herramienta de dibujo bloquea el desplazamiento)
let pinch = null;
const touchMid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
viewerEl.addEventListener('touchstart', (e) => {
  // Al dibujar, el navegador no debe interpretar el trazo como un gesto de desplazamiento: si lo hace,
  // el siguiente toque rápido (p. ej. en un botón) se usa para "frenar" ese gesto y no genera clic.
  // Lo mismo al arrastrar tiradores u objetos; así además el texto en edición no pierde el foco
  const cls = document.body.classList;
  if ((cls.contains('draw-mode') && e.target.closest('.page')) || e.target.closest('.handle, .grip') ||
      (cls.contains('tool-select') && e.target.closest('.obj') && !e.target.isContentEditable)) {
    e.preventDefault();
  } else if (e.target.isContentEditable && (cls.contains('tool-text') || cls.contains('tool-edittext')) && e.touches.length === 1) {
    // Un toque desviado al texto en edición que en realidad cayó en otra línea u otro texto: el navegador no debe
    // mover el cursor (lo gestiona onPagePointerDown)
    const t = e.touches[0];
    const real = document.elementsFromPoint(t.clientX, t.clientY).find((n) => !n.closest('.sel'));
    if (real && !e.target.contains(real) && real.closest('.tl-box, .obj-text')) e.preventDefault();
  }
  if (e.touches.length === 2 && state.pages.length) {
    pinch = { d: touchDist(e.touches), z: state.zoom, mid: touchMid(e.touches) };
  }
}, { passive: false });
viewerEl.addEventListener('touchmove', (e) => {
  // Arrastrar un objeto tampoco debe convertirse en un gesto de desplazamiento del navegador
  if (e.cancelable && e.touches.length === 1 && e.target.closest('.obj, .handle, .grip')) e.preventDefault();
  if (!pinch || e.touches.length !== 2) return;
  if (e.cancelable) e.preventDefault();
  const mid = touchMid(e.touches);
  if (document.body.classList.contains('draw-mode')) {
    viewerEl.scrollLeft -= mid.x - pinch.mid.x;
    viewerEl.scrollTop -= mid.y - pinch.mid.y;
  }
  pinch.mid = mid;
  setZoom(pinch.z * (touchDist(e.touches) / pinch.d), mid);
}, { passive: false });
viewerEl.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; }, { passive: true });

on('tool', () => {
  for (const p of state.pages) {
    if (!visible.has(p.uid)) continue;
    if (state.tool === 'edittext') renderTextBoxes(p);
    // Para resaltar una línea con un toque, o para avisar de que un texto hay que abrirlo antes de pintarlo
    else if (state.tool === 'highlight' || state.tool === 'fill') getLines(p);
  }
});
window.addEventListener('resize', () => scheduleRender(250));

export const visiblePages = () => [...visible];
