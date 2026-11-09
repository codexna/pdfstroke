// Estado global, eventos e historial (deshacer/rehacer).

export const state = {
  sources: new Map(),   // id -> { id, name, bytes: Uint8Array, pdf: PDFDocumentProxy }
  pages: [],            // [{ uid, src, index, w, h, view, baseRotate, rotation, objects: [] }]
  assets: {},           // id -> { src: dataURL, mime, w, h }
  fileName: 'documento.pdf',
  fileHandle: null,
  zoom: 1,
  tool: 'select',
  selection: null,      // { uid, id }
  dirty: false,
  style: {
    family: 'sans', size: 14, bold: false, italic: false, textColor: '#111111',
    stroke: '#d32f2f', fill: '#ffffff', fillOn: false, width: 2, opacity: 1,
    hlcolor: '#fff176', whiteout: '#ffffff', bucket: '#ffe082',
  },
};

let seq = 0;
export const uid = (p = 'o') => p + Date.now().toString(36) + (seq++).toString(36);

const listeners = {};
export function on(ev, fn) { (listeners[ev] ||= []).push(fn); }
export function emit(ev, data) { (listeners[ev] || []).forEach((fn) => fn(data)); }

export const findPage = (uid) => state.pages.find((p) => p.uid === uid);
export const findObj = (page, id) => page?.objects.find((o) => o.id === id);
export const pageSig = () => state.pages.map((p) => p.uid + ':' + p.rotation).join('|');

const NUM_KEYS = ['x', 'y', 'size', 'w', 'h'];
const STYLE_KEYS = ['family', 'bold', 'italic', 'color', 'noScale', 'opacity'];
/**
 * Línea original abierta para editar pero que sigue exactamente como estaba (texto, formato, tamaño y posición):
 * no se dibuja en el PDF, no se guarda en el historial y desaparece al dejar de seleccionarla.
 */
export function isNoopEdit(o) {
  const b = o.base;
  if (!o.lineKey || !b || o.text !== b.text) return false;
  for (const k of NUM_KEYS) if (Math.abs((o[k] ?? 0) - (b[k] ?? 0)) > 1e-3) return false;
  for (const k of STYLE_KEYS) if ((o[k] ?? null) !== (b[k] ?? null)) return false;
  return JSON.stringify(o.runs ?? null) === JSON.stringify(b.runs ?? null);
}

// ---- Historial: se guardan instantáneas JSON de las páginas (los recursos pesados viven en state.assets) ----
const undoStack = [];
const redoStack = [];
const MAX_HISTORY = 150;

// Estilos por defecto elegidos sin nada seleccionado (p. ej. un color tomado con el cuentagotas): no son un paso del
// historial, así que deshacer o rehacer otra cosa no debe devolverlos a como estaban
const chosenDefaults = {};
// Los colores y grosores de las herramientas de dibujo nunca vuelven atrás al deshacer (sólo el formato del texto,
// para que un texto nuevo no herede un formato que se ha deshecho)
const DRAWING_STYLE = ['stroke', 'fill', 'fillOn', 'width', 'opacity', 'hlcolor', 'whiteout', 'bucket'];
export function setDefaultStyle(prop, value) {
  state.style[prop] = value;
  chosenDefaults[prop] = value;
}
/** Un cambio de estilo que sí es un paso del historial (al darle formato a algo): deshacerlo lo devuelve también. */
export function styleChanged(prop) { delete chosenDefaults[prop]; }

// Incluye el estilo por defecto: al deshacer un formato, el siguiente texto nuevo tampoco lo hereda
export const snapshot = () => JSON.stringify({
  pages: state.pages.map((p) => ({ ...p, objects: p.objects.filter((o) => !isNoopEdit(o)) })),
  style: state.style,
});

/** Guarda el estado actual justo antes de modificarlo. */
export function checkpoint() { pushUndo(snapshot()); }

/** Guarda una instantánea tomada antes de una modificación ya hecha (no hace nada si no cambió nada). */
export function checkpointFrom(snap) {
  if (snap !== snapshot()) pushUndo(snap);
}

function pushUndo(snap) {
  undoStack.push(snap);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  state.dirty = true;
  emit('history');
}

function restore(snap) {
  const before = pageSig();
  const data = JSON.parse(snap);
  state.pages = data.pages;
  if (data.style) {
    const drawing = Object.fromEntries(DRAWING_STYLE.filter((k) => k in state.style).map((k) => [k, state.style[k]]));
    state.style = { ...data.style, ...chosenDefaults, ...drawing };
  }
  state.selection = null;
  state.dirty = true;
  emit('restore', { structural: before !== pageSig() });
  emit('history');
}

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}

export function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  state.dirty = false;
  emit('history');
}
