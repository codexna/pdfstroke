// Panel de miniaturas y operaciones de páginas (rotar, mover, eliminar, añadir).
import { t } from './i18n.js';
import { state, on, emit, uid, checkpoint } from './state.js';
import { scrollToPage, currentPageUid, shownSize } from './viewer.js';
import { deselect } from './objects.js';

const thumbsEl = document.getElementById('thumbs');
const sidebar = document.getElementById('sidebar');
const baseCache = new Map(); // "src:index" -> Promise<canvas> (miniatura sin rotación del usuario)
const THUMB_W = 132;

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    io.unobserve(e.target);
    drawThumb(e.target);
  }
}, { root: sidebar, rootMargin: '300px 0px' });

function baseThumb(p) {
  const key = p.src == null ? `blank:${p.w}x${p.h}` : `${p.src}:${p.index}`;
  if (!baseCache.has(key)) {
    baseCache.set(key, (async () => {
      const scale = (THUMB_W * Math.min(2, window.devicePixelRatio || 1)) / Math.max(p.w, p.h);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(p.w * scale));
      c.height = Math.max(1, Math.round(p.h * scale));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      if (p.src != null) {
        const page = await state.sources.get(p.src).pdf.getPage(p.index + 1);
        await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: c.width / p.w }) }).promise;
      }
      return c;
    })());
  }
  return baseCache.get(key);
}

async function drawThumb(item) {
  const p = state.pages.find((q) => q.uid === item.dataset.uid);
  if (!p) return;
  let base;
  try { base = await baseThumb(p); } catch (err) { console.error(err); return; }
  const r = p.rotation;
  const c = document.createElement('canvas');
  c.width = r % 180 ? base.height : base.width;
  c.height = r % 180 ? base.width : base.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((r * Math.PI) / 180);
  ctx.drawImage(base, -base.width / 2, -base.height / 2);
  const holder = item.querySelector('.thumb-img');
  holder.innerHTML = '';
  holder.appendChild(c);
}

const btn = (act, icon, title) =>
  `<button class="icon-btn xs" data-act="${act}" title="${title}"><svg><use href="#${icon}"/></svg></button>`;

export function renderThumbs() {
  thumbsEl.innerHTML = '';
  const cur = currentPageUid();
  state.pages.forEach((p, i) => {
    const { w, h } = shownSize(p);
    const item = document.createElement('div');
    item.className = 'thumb' + (p.uid === cur ? ' current' : '');
    item.dataset.uid = p.uid;
    item.draggable = true;
    item.innerHTML =
      `<div class="thumb-img" style="aspect-ratio:${w} / ${h}"></div>` +
      `<div class="thumb-bar"><span class="num">${i + 1}</span><span class="spacer"></span>` +
      btn('rotl', 'i-rot-ccw', t('Girar a la izquierda')) + btn('rotr', 'i-rot-cw', t('Girar a la derecha')) +
      btn('up', 'i-up', t('Mover arriba')) + btn('down', 'i-down', t('Mover abajo')) +
      btn('dup', 'i-copy', t('Duplicar página')) + btn('del', 'i-trash', t('Eliminar página')) + '</div>';
    thumbsEl.appendChild(item);
    io.observe(item);
  });
}

// ---------- Operaciones ----------
const indexOf = (pageUid) => state.pages.findIndex((p) => p.uid === pageUid);

export function rotatePage(pageUid, delta) {
  const p = state.pages[indexOf(pageUid)];
  if (!p) return;
  deselect();
  checkpoint();
  p.rotation = (p.rotation + delta + 360) % 360;
  emit('pages');
}

export function movePage(pageUid, to) {
  const from = indexOf(pageUid);
  if (from < 0 || to < 0 || to >= state.pages.length || to === from) return;
  deselect();
  checkpoint();
  const [p] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, p);
  emit('pages');
}

export function deletePage(pageUid) {
  if (state.pages.length <= 1) { emit('toast', t('El documento debe tener al menos una página.')); return; }
  const i = indexOf(pageUid);
  if (i < 0) return;
  deselect();
  checkpoint();
  state.pages.splice(i, 1);
  if (state.selection?.uid === pageUid) state.selection = null;
  emit('pages');
}

export function duplicatePage(pageUid) {
  const i = indexOf(pageUid);
  if (i < 0) return;
  deselect();
  checkpoint();
  const copy = structuredClone(state.pages[i]);
  copy.uid = uid('p');
  copy.objects.forEach((o) => { o.id = uid(); });
  state.pages.splice(i + 1, 0, copy);
  emit('pages');
}

export function blankPage(w = 595.28, h = 841.89) {
  return { uid: uid('p'), src: null, index: 0, w, h, view: [0, 0, w, h], baseRotate: 0, rotation: 0, objects: [] };
}

export function addBlankPage() {
  const i = Math.max(0, indexOf(currentPageUid()));
  const ref = state.pages[i];
  const { w, h } = ref ? shownSize(ref) : { w: 595.28, h: 841.89 };
  deselect();
  checkpoint();
  const p = blankPage(w, h);
  state.pages.splice(i + 1, 0, p);
  emit('pages');
  requestAnimationFrame(() => scrollToPage(p.uid));
}

export function insertPagesAfterCurrent(pages) {
  const i = indexOf(currentPageUid());
  deselect();
  checkpoint();
  state.pages.splice(i + 1, 0, ...pages);
  emit('pages');
  requestAnimationFrame(() => scrollToPage(pages[0].uid));
}

// ---------- Eventos ----------
thumbsEl.addEventListener('click', (e) => {
  const item = e.target.closest('.thumb');
  if (!item) return;
  const pageUid = item.dataset.uid;
  const act = e.target.closest('[data-act]')?.dataset.act;
  const i = indexOf(pageUid);
  switch (act) {
    case 'rotl': return rotatePage(pageUid, -90);
    case 'rotr': return rotatePage(pageUid, 90);
    case 'up': return movePage(pageUid, i - 1);
    case 'down': return movePage(pageUid, i + 1);
    case 'dup': return duplicatePage(pageUid);
    case 'del': return deletePage(pageUid);
    default:
      scrollToPage(pageUid);
      emit('thumbnav');
  }
});

// Reordenar arrastrando (escritorio)
let dragUid = null;
thumbsEl.addEventListener('dragstart', (e) => {
  const item = e.target.closest('.thumb');
  if (!item) return;
  dragUid = item.dataset.uid;
  e.dataTransfer.effectAllowed = 'move';
  item.classList.add('dragging');
});
thumbsEl.addEventListener('dragend', () => {
  dragUid = null;
  thumbsEl.querySelectorAll('.dragging,.drop-before,.drop-after').forEach((n) => n.classList.remove('dragging', 'drop-before', 'drop-after'));
});
thumbsEl.addEventListener('dragover', (e) => {
  if (!dragUid) return;
  e.preventDefault();
  const item = e.target.closest('.thumb');
  thumbsEl.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  if (!item || item.dataset.uid === dragUid) return;
  const r = item.getBoundingClientRect();
  item.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
});
thumbsEl.addEventListener('drop', (e) => {
  if (!dragUid) return;
  e.preventDefault();
  e.stopPropagation();
  const item = e.target.closest('.thumb');
  if (!item || item.dataset.uid === dragUid) return;
  const r = item.getBoundingClientRect();
  const from = indexOf(dragUid);
  let to = indexOf(item.dataset.uid) + (e.clientY < r.top + r.height / 2 ? 0 : 1);
  if (from < to) to--;
  movePage(dragUid, to);
});

on('currentpage', (cur) => {
  thumbsEl.querySelectorAll('.thumb.current').forEach((n) => n.classList.remove('current'));
  const item = thumbsEl.querySelector(`.thumb[data-uid="${cur}"]`);
  if (item) {
    item.classList.add('current');
    const r = item.getBoundingClientRect(), s = sidebar.getBoundingClientRect();
    if (r.top < s.top || r.bottom > s.bottom) item.scrollIntoView({ block: 'nearest' });
  }
});
