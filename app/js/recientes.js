// Archivos recientes (pantalla de inicio): una copia de los últimos PDF abiertos o guardados, en el propio
// dispositivo (IndexedDB), para volver a abrirlos con un toque. Nunca salen del dispositivo.
import { t } from './i18n.js';

const DB = 'pdfstroke';
const STORE = 'recientes';
const MAX = 8;
const MAX_BYTES = 150 * 1024 * 1024; // en total
const MAX_UNO = 40 * 1024 * 1024; // uno muy grande no se guarda

let dbp = null;
function db() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'name' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  });
  return dbp;
}
const tx = async (mode, fn) => {
  const d = await db();
  return new Promise((res, rej) => {
    const x = d.transaction(STORE, mode);
    const out = fn(x.objectStore(STORE));
    x.oncomplete = () => res(out?.result ?? out);
    x.onerror = () => rej(x.error);
  });
};

async function all() {
  try {
    const list = await tx('readonly', (s) => s.getAll());
    return (list || []).sort((a, b) => b.date - a.date);
  } catch { return []; }
}

/** Guarda (o actualiza) un archivo en recientes. */
export async function addRecent(name, bytes, pages = 0) {
  try {
    if (!bytes?.length || bytes.length > MAX_UNO) return;
    await tx('readwrite', (s) => s.put({ name, date: Date.now(), size: bytes.length, pages, blob: new Blob([bytes], { type: 'application/pdf' }) }));
    // Se quitan los más antiguos si hay demasiados o pesan demasiado
    const list = await all();
    let total = 0;
    const sobran = list.filter((r, i) => { total += r.size; return i >= MAX || total > MAX_BYTES; });
    if (sobran.length) await tx('readwrite', (s) => sobran.forEach((r) => s.delete(r.name)));
    renderRecents();
  } catch (err) {
    console.warn('No se pudo guardar en recientes', err);
  }
}

export async function removeRecent(name) {
  try { await tx('readwrite', (s) => s.delete(name)); } catch { /* nada */ }
  renderRecents();
}

let opener = null;
export function initRecents(open) {
  opener = open;
  renderRecents();
}

function when(ms) {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString();
}

export async function renderRecents() {
  const box = document.getElementById('recents');
  const listEl = document.getElementById('recentList');
  if (!box || !listEl) return;
  const list = await all();
  box.hidden = !list.length;
  listEl.innerHTML = '';
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'recent';
    row.innerHTML = `<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>
      <span class="r-name"></span><span class="r-meta"></span>
      <button class="icon-btn sm" title="${t('Quitar de recientes')}"><svg><use href="#i-close"/></svg></button>`;
    row.querySelector('.r-name').textContent = r.name;
    const kb = r.size >= 1048576 ? (r.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(r.size / 1024)) + ' KB';
    row.querySelector('.r-meta').textContent = `${when(r.date)} · ${kb}`;
    row.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); removeRecent(r.name); });
    row.addEventListener('click', () => opener?.(new File([r.blob], r.name, { type: 'application/pdf' })));
    listEl.appendChild(row);
  }
}
