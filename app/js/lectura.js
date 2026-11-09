// Modo lectura: el documento a pantalla completa, sin barras ni herramientas. Un toque en el centro muestra u oculta
// los controles; en los lados (o deslizando), página anterior o siguiente. Fondo normal, sepia o noche. Recuerda en
// qué página se quedó cada documento. En la app de Android oculta también las barras del sistema y mantiene la
// pantalla encendida (plugin «Lectura»).
import { t } from './i18n.js';
import { state, on } from './state.js';
import { viewerEl, fitWidth, scrollToPage, currentPageUid } from './viewer.js';
import { startReading, stopReading, isReadingAloud } from './voz.js';
import { deselect } from './objects.js';

const cap = window.Capacitor?.isNativePlatform?.() ? window.Capacitor : null;
const plugin = cap?.Plugins?.Lectura || null;
const $ = (id) => document.getElementById(id);
const body = document.body;
const THEMES = ['normal', 'sepia', 'night'];
const POS = 'editorpdf.lectura.pos';
const THEME = 'editorpdf.lectura.tema';

let hideTimer = null;
let prevZoom = null;
let toast = () => {};

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

export const isReading = () => body.classList.contains('reading');
const docKey = () => state.fileName + '|' + state.pages.length;

function setTheme(th) {
  for (const x of THEMES) body.classList.toggle('page-' + x, x === th);
  store.set(THEME, th);
  $('readTheme').title = th === 'night' ? t('Fondo: noche') : th === 'sepia' ? t('Fondo: sepia') : t('Fondo: normal');
}

function showBars(show) {
  body.classList.toggle('reading-ui', show);
  clearTimeout(hideTimer);
  if (show) hideTimer = setTimeout(() => body.classList.remove('reading-ui'), 4000);
}

function pageIndex() { return Math.max(0, state.pages.findIndex((p) => p.uid === currentPageUid())); }
function goPage(d) {
  const i = Math.max(0, Math.min(state.pages.length - 1, pageIndex() + d));
  scrollToPage(state.pages[i].uid, 0, true);
}

function updateTitle() {
  if (!isReading()) return;
  const i = pageIndex();
  $('readPage').textContent = `${i + 1} / ${state.pages.length}`;
  const pos = store.get(POS, {});
  pos[docKey()] = i;
  // Solo los últimos 50 documentos
  const keys = Object.keys(pos);
  if (keys.length > 50) delete pos[keys[0]];
  store.set(POS, pos);
}

export function enterReading() {
  if (!state.pages.length || isReading()) return;
  prevZoom = state.zoom;
  deselect();
  body.classList.add('reading');
  $('readTitle').textContent = state.fileName.replace(/\.pdf$/i, '');
  setTheme(store.get(THEME, 'normal'));
  plugin?.entrar().catch(() => {});
  if (!cap) document.documentElement.requestFullscreen?.().catch(() => {});
  requestAnimationFrame(() => {
    fitWidth(4);
    const saved = store.get(POS, {})[docKey()];
    if (saved > 0 && saved < state.pages.length) {
      scrollToPage(state.pages[saved].uid);
      toast(t('Continúas en la página {n}.', { n: saved + 1 }));
    }
    updateTitle();
    showBars(true);
  });
}

export function exitReading() {
  if (!isReading()) return;
  updateTitle();
  body.classList.remove('reading', 'reading-ui', ...THEMES.map((x) => 'page-' + x));
  clearTimeout(hideTimer);
  plugin?.salir().catch(() => {});
  if (!cap && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  const uid = currentPageUid();
  requestAnimationFrame(() => {
    if (prevZoom) fitWidth(viewerEl.clientWidth < 700 ? 3 : 1.25);
    scrollToPage(uid);
  });
}

export function initLectura(opts) {
  toast = opts.toast;
  $('readExit').addEventListener('click', exitReading);
  $('readTheme').addEventListener('click', () => {
    const cur = THEMES.find((x) => body.classList.contains('page-' + x)) || 'normal';
    setTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
    showBars(true);
  });
  $('readAloud').addEventListener('click', () => { if (isReadingAloud()) stopReading(); else startReading(); showBars(true); });
  $('readPrev').addEventListener('click', () => { goPage(-1); showBars(true); });
  $('readNext').addEventListener('click', () => { goPage(1); showBars(true); });
  on('currentpage', updateTitle);

  // Toques y gestos sobre el documento (en modo lectura no se edita nada)
  let start = null;
  viewerEl.addEventListener('pointerdown', (e) => {
    if (!isReading()) return;
    start = { x: e.clientX, y: e.clientY, t: performance.now() };
  }, true);
  viewerEl.addEventListener('pointerup', (e) => {
    if (!isReading() || !start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y, dt = performance.now() - start.t;
    start = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2 && dt < 800) { goPage(dx < 0 ? 1 : -1); return; }
    if (Math.hypot(dx, dy) > 10 || dt > 600) return;
    const w = viewerEl.clientWidth;
    const x = e.clientX - viewerEl.getBoundingClientRect().left;
    if (x < w * 0.22) goPage(-1);
    else if (x > w * 0.78) goPage(1);
    else showBars(!body.classList.contains('reading-ui'));
  }, true);
  // En modo lectura, ningún toque llega a las herramientas de edición
  for (const ev of ['pointerdown', 'click']) {
    viewerEl.addEventListener(ev, (e) => { if (isReading() && e.target.closest('.page')) e.stopPropagation(); }, true);
  }
  document.addEventListener('keydown', (e) => {
    if (!isReading()) return;
    if (e.key === 'Escape') exitReading();
    else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); goPage(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPage(-1); }
  });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && isReading() && !cap) exitReading(); });
  // Botón «atrás» de Android: sale del modo lectura
  cap?.Plugins?.App?.addListener('backButton', () => {
    if (isReading()) exitReading();
    else if (isReadingAloud()) stopReading();
    else if (window.history.length > 1) window.history.back();
    else cap.Plugins.App.exitApp?.();
  });
}
