import { t } from './i18n.js';
// Ventana para dibujar firmas (y reutilizar las guardadas en este dispositivo).
const modal = document.getElementById('signModal');
const pad = document.getElementById('signPad');
const savedEl = document.getElementById('savedSigns');
const STORE_KEY = 'editorpdf.firmas';
let ctx, color = '#111111', hasInk = false, resolver = null;

const loadSaved = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; } };
const storeSaved = (list) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 4))); } catch { /* sin almacenamiento */ } };

function renderSaved() {
  const list = loadSaved();
  savedEl.innerHTML = '';
  savedEl.hidden = !list.length;
  list.forEach((src, i) => {
    const b = document.createElement('div');
    b.className = 'saved-sign';
    b.innerHTML = `<img src="${src}" alt="${t('Firma guardada')}"><button class="icon-btn xs" title="${t('Olvidar firma')}"><svg><use href="#i-close"/></svg></button>`;
    b.querySelector('img').addEventListener('click', () => close(src));
    b.querySelector('button').addEventListener('click', () => { const l = loadSaved(); l.splice(i, 1); storeSaved(l); renderSaved(); });
    savedEl.appendChild(b);
  });
}

function setup() {
  const r = pad.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  pad.width = Math.round(r.width * dpr);
  pad.height = Math.round(r.height * dpr);
  ctx = pad.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2.6 * dpr;
  hasInk = false;
}

let last = null, mid = null;
pad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  pad.setPointerCapture(e.pointerId);
  const r = pad.getBoundingClientRect(), k = pad.width / r.width;
  last = mid = [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(last[0], last[1], ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  hasInk = true;
});
pad.addEventListener('pointermove', (e) => {
  if (!last) return;
  const r = pad.getBoundingClientRect(), k = pad.width / r.width;
  for (const ce of e.getCoalescedEvents?.() || [e]) {
    const q = [(ce.clientX - r.left) * k, (ce.clientY - r.top) * k];
    const m = [(last[0] + q[0]) / 2, (last[1] + q[1]) / 2];
    ctx.beginPath();
    ctx.moveTo(mid[0], mid[1]);
    ctx.quadraticCurveTo(last[0], last[1], m[0], m[1]);
    ctx.stroke();
    last = q; mid = m;
  }
});
pad.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
const endStroke = () => { last = mid = null; };
pad.addEventListener('pointerup', endStroke);
pad.addEventListener('pointercancel', endStroke);

/** Recorta el lienzo al área con tinta y lo devuelve como PNG transparente. */
function trimmed() {
  const { width: w, height: h } = pad;
  const data = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const m = 6;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
  x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  const c = document.createElement('canvas');
  c.width = x1 - x0 + 1;
  c.height = y1 - y0 + 1;
  c.getContext('2d').drawImage(pad, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function close(result) {
  modal.hidden = true;
  resolver?.(result);
  resolver = null;
}

document.getElementById('signClose').addEventListener('click', () => close(null));
// «Firma digital con certificado»: se cierra esta ventana y app.js abre la de la firma digital
document.getElementById('signDigital').addEventListener('click', () => close(null));
document.getElementById('signClear').addEventListener('click', setup);
document.getElementById('signOk').addEventListener('click', () => {
  const src = hasInk ? trimmed() : null;
  if (!src) return close(null);
  storeSaved([src, ...loadSaved().filter((s) => s !== src)]);
  close(src);
});
document.getElementById('signColors').addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]');
  if (!b) return;
  color = b.dataset.c;
  document.querySelectorAll('#signColors [data-c]').forEach((n) => n.classList.toggle('on', n === b));
});
modal.addEventListener('click', (e) => { if (e.target === modal) close(null); });

/** Abre la ventana de firma. Devuelve un dataURL PNG o null si se cancela. */
export function askSignature() {
  modal.hidden = false;
  renderSaved();
  requestAnimationFrame(setup);
  return new Promise((res) => { resolver = res; });
}
