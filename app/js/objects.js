// Objetos añadidos sobre las páginas (texto, imágenes, formas, dibujos) y las herramientas que los crean.
import { t } from './i18n.js';
import {
  state, uid, on, emit, findPage, findObj, snapshot, checkpointFrom, isNoopEdit, undo, redo, canUndo, canRedo, setDefaultStyle, styleChanged,
} from './state.js';
import { getEls, toLocal, currentPageUid, viewerEl, refreshPatches } from './viewer.js';
import { getLines, linesSync, sampleColors, invalidateTextBoxes } from './textlayer.js';
import { toPdfText } from './pdftext.js';
import { colorAt, hitObject } from './paint.js';

export { isNoopEdit };

// ---------- Tipografía ----------
export const LH = 1.2;
const METRICS = { sans: { a: 0.905, d: 0.212 }, serif: { a: 0.891, d: 0.216 }, mono: { a: 0.833, d: 0.3 } };
// Arimo, Tinos y Cousine tienen las mismas medidas que Helvetica, Times y Courier (las fuentes estándar del PDF):
// así el texto ocupa lo mismo en pantalla (también en Android) que en el PDF guardado.
export const FONT_CSS = {
  sans: 'Arimo, Helvetica, Arial, sans-serif',
  serif: 'Tinos, "Times New Roman", Times, serif',
  mono: 'Cousine, "Courier New", Courier, monospace',
};
/** Distancia teórica desde el borde superior de una línea CSS hasta la línea base, en unidades de tamaño de letra. */
export function baselineOffset(family, lh = LH) {
  const m = METRICS[family] || METRICS.sans;
  return (lh - (m.a + m.d)) / 2 + m.a;
}

/** Ajusta una escala horizontal a un rango razonable (y la ignora si es casi 1). */
export function clampScale(hs) {
  hs = Math.min(1.35, Math.max(0.65, hs || 1));
  return Math.abs(hs - 1) < 0.03 ? 1 : hs;
}

const measureCtx = document.createElement('canvas').getContext('2d');
if ('fontKerning' in measureCtx) measureCtx.fontKerning = 'none';
const hsCache = new Map();
const metricsCache = new Map();

/** Se resuelve cuando las fuentes de pantalla están cargadas (hay que esperarla antes de medir o exportar texto). */
export const fontsReady = (async () => {
  if (!document.fonts?.load) return;
  const faces = [];
  for (const fam of ['Arimo', 'Tinos', 'Cousine']) {
    for (const w of [400, 700]) for (const st of ['normal', 'italic']) faces.push(`${st} ${w} 16px ${fam}`);
  }
  try { await Promise.all(faces.map((f) => document.fonts.load(f))); } catch { /* se usarán las fuentes del sistema */ }
  hsCache.clear();
  metricsCache.clear();
})();

/**
 * Medidas reales (en el navegador) de las líneas de un texto: distancia desde el borde superior de la caja hasta la
 * línea base de la primera línea, y separación entre líneas. El navegador redondea las métricas de la fuente y la
 * altura de línea, así que se miden en lugar de calcularlas.
 */
export function textMetrics(family, size) {
  const key = family + '|' + size;
  let m = metricsCache.get(key);
  if (m) return m;
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'absolute', left: '-100000px', top: '0', visibility: 'hidden', whiteSpace: 'pre',
    fontFamily: FONT_CSS[family] || FONT_CSS.sans, fontSize: size + 'px', lineHeight: String(LH),
  });
  const mark = () => {
    const s = document.createElement('span');
    Object.assign(s.style, { display: 'inline-block', width: '0', height: '0', verticalAlign: 'baseline' });
    return s;
  };
  const m1 = mark(), m2 = mark();
  box.append(m1, 'Hg\n', m2, 'Hg');
  document.body.appendChild(box);
  const top = box.getBoundingClientRect().top;
  let baseline = m1.getBoundingClientRect().top - top;
  let pitch = m2.getBoundingClientRect().top - top - baseline;
  box.remove();
  if (!(baseline > 0 && baseline < size * 2)) baseline = baselineOffset(family) * size;
  if (!(pitch > size * 0.5 && pitch < size * 3)) pitch = size * LH;
  m = { baseline, pitch };
  metricsCache.set(key, m);
  return m;
}

/** Distancia real desde el borde superior de una caja de texto hasta la línea base de su primera línea. */
export const textBaseline = (family, size) => textMetrics(family, size).baseline;

/** Escala horizontal que imita el ancho de la fuente original de una línea editada. */
export function hScale(o) {
  if (!o.orig?.w || o.noScale) return 1;
  const key = JSON.stringify(o.orig);
  if (hsCache.has(key)) return hsCache.get(key);
  let w = 0;
  for (const r of o.orig.runs) {
    measureCtx.font = `${r.italic ? 'italic ' : ''}${r.bold ? 'bold ' : ''}100px ${FONT_CSS[r.family] || FONT_CSS.sans}`;
    // Se mide el mismo texto que se escribirá en el PDF (p. ej. "−" se escribe como "-")
    w += (measureCtx.measureText(toPdfText(r.text)).width * o.orig.size) / 100;
  }
  const hs = clampScale(w > 0 ? o.orig.w / w : 1);
  hsCache.set(key, hs);
  return hs;
}

// ---------- Tramos de estilo (negrita, cursiva, fuente y color de partes del texto) ----------
const RUN_FIELDS = new Set(['family', 'bold', 'italic', 'color']);
const runStyle = (r, o) => ({
  family: r.family ?? o.family, bold: !!(r.bold ?? o.bold), italic: !!(r.italic ?? o.italic), color: r.color ?? o.color,
});
/** Tramos de estilo de un texto (siempre al menos uno), con todos sus campos resueltos. */
export const textRuns = (o) => (o.runs || [{ text: o.text || '' }]).map((r) => ({ text: r.text, ...runStyle(r, o) }));
const sameStyle = (a, b) => a.family === b.family && a.bold === b.bold && a.italic === b.italic && a.color === b.color;

/** Une tramos contiguos con el mismo estilo; si todo el texto tiene un único estilo, elimina los tramos. */
function normalizeRuns(o, runs = textRuns(o)) {
  const out = [];
  for (const r of runs) {
    if (!r.text) continue;
    const st = runStyle(r, o);
    const last = out[out.length - 1];
    if (last && sameStyle(last, st)) last.text += r.text;
    else out.push({ text: r.text, ...st });
  }
  o.text = out.map((r) => r.text).join('');
  if (!out.length) { delete o.runs; return; }
  if (out.every((r) => sameStyle(r, out[0]))) {
    Object.assign(o, { family: out[0].family, bold: out[0].bold, italic: out[0].italic, color: out[0].color });
    delete o.runs;
  } else {
    o.runs = out;
  }
}

/** Cambia un campo de estilo sólo en el intervalo [start, end) del texto. */
function setRunsField(runs, start, end, field, value) {
  const out = [];
  let pos = 0;
  for (const r of runs) {
    const a = pos, b = pos + r.text.length;
    pos = b;
    if (b <= start || a >= end) { out.push({ ...r }); continue; }
    const piece = (s, e, styled) => { if (e > s) out.push({ ...r, text: r.text.slice(s - a, e - a), ...(styled ? { [field]: value } : {}) }); };
    piece(a, Math.max(a, start), false);
    piece(Math.max(a, start), Math.min(b, end), true);
    piece(Math.min(b, end), b, false);
  }
  return out;
}

/** Tramos que se solapan con el intervalo [start, end) del texto. */
function runsInRange(runs, [start, end]) {
  let pos = 0;
  return runs.filter((r) => { const a = pos; pos += r.text.length; return pos > start && a < end; });
}

/** Lee el texto y sus tramos de estilo del elemento editable. */
function readRuns(el, base) {
  const runs = [];
  let lastChar = '';
  const push = (text, st) => {
    if (!text) return;
    runs.push({ text, ...st });
    lastChar = text[text.length - 1];
  };
  const walk = (node, st) => {
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) push(n.data.replace(/ /g, ' ').replace(/\r/g, ''), st);
      else if (n.nodeName === 'BR') push('\n', st);
      else if (n.nodeType === Node.ELEMENT_NODE) {
        if (/^(DIV|P|LI)$/.test(n.nodeName) && runs.length && lastChar !== '\n') push('\n', st);
        const d = n.dataset || {};
        walk(n, d.f ? { family: d.f, bold: d.b === '1', italic: d.i === '1', color: d.c || st.color } : st);
      }
    }
  };
  walk(el, runStyle({}, base));
  // Un salto de línea final es sólo el "relleno" que necesita una última línea vacía (ver fillTextEl)
  const last = runs[runs.length - 1];
  if (last?.text.endsWith('\n')) last.text = last.text.slice(0, -1);
  return runs;
}

/** Posición en el texto (como lo devuelve readRuns) de un punto del DOM dentro del elemento editable. */
function textOffset(el, container, offset) {
  let count = 0, lastChar = '', found = null;
  const walk = (node) => {
    for (let i = 0; i < node.childNodes.length && found === null; i++) {
      if (node === container && i === offset) { found = count; return; }
      const n = node.childNodes[i];
      if (n.nodeType === Node.TEXT_NODE) {
        if (n === container) { found = count + offset; return; }
        count += n.data.length;
        if (n.data.length) lastChar = n.data[n.data.length - 1];
      } else if (n.nodeName === 'BR') {
        count++;
        lastChar = '\n';
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        if (/^(DIV|P|LI)$/.test(n.nodeName) && count > 0 && lastChar !== '\n') { count++; lastChar = '\n'; }
        walk(n);
      }
    }
    if (found === null && node === container) found = count;
  };
  walk(el);
  return found ?? count;
}

/** Selección actual dentro del elemento, como [inicio, fin] en el texto, o null. */
function selectionOffsets(el) {
  const s = window.getSelection();
  if (!s?.rangeCount) return null;
  const r = s.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  const a = textOffset(el, r.startContainer, r.startOffset), b = textOffset(el, r.endContainer, r.endOffset);
  return [Math.min(a, b), Math.max(a, b)];
}

/** Restaura una selección [inicio, fin] en un elemento recién rellenado por fillTextEl. */
function setSelectionOffsets(el, range) {
  if (!range) return;
  const at = (target) => {
    let count = 0, last = null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (count + n.data.length >= target) return [n, target - count];
      count += n.data.length;
      last = n;
    }
    return last ? [last, last.data.length] : [el, 0];
  };
  const [sn, so] = at(range[0]);
  const [en, eo] = at(range[1]);
  const r = document.createRange();
  r.setStart(sn, so);
  r.setEnd(en, eo);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

export function arrowHead(o) {
  const L = Math.max(7, o.width * 3.2 + 5);
  const a = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
  const sp = 0.42;
  return {
    L,
    tip: [o.x2, o.y2],
    left: [o.x2 - L * Math.cos(a - sp), o.y2 - L * Math.sin(a - sp)],
    right: [o.x2 - L * Math.cos(a + sp), o.y2 - L * Math.sin(a + sp)],
    base: [o.x2 - L * 0.8 * Math.cos(a), o.y2 - L * 0.8 * Math.sin(a)],
  };
}

export const ellipseK = 0.5522847498;

// ---------- Elementos de texto ----------
/** Aplica posición, tamaño de caja y estilo de un texto a su elemento (sin tocar su contenido). */
function styleTextEl(el, o, pageW) {
  const hs = hScale(o);
  // Sin ancho fijo, el texto se reparte en líneas al llegar al borde de la página
  const avail = Math.max(o.size * 2, (pageW ?? Infinity) - o.x);
  Object.assign(el.style, {
    left: o.x + 'px', top: o.y + 'px', fontSize: o.size + 'px', fontFamily: FONT_CSS[o.family] || FONT_CSS.sans,
    fontWeight: o.bold ? '700' : '400', fontStyle: o.italic ? 'italic' : 'normal', color: o.color, lineHeight: LH,
    opacity: o.opacity ?? 1,
    // La escala horizontal se aplica después de repartir las líneas, por eso los anchos se compensan
    // Sin ancho fijo, la caja mide lo que su texto (como mucho hasta el borde de la página), sin depender del
    // contenedor: así se reparten igual las líneas en pantalla y en la copia con la que se mide para el PDF
    width: o.w ? o.w / hs + 'px' : 'max-content',
    maxWidth: !o.w && Number.isFinite(avail) ? avail / hs + 'px' : '',
    // El alto extra de una caja estirada sólo se dibuja en la selección: el elemento mide lo que su texto y no
    // tapa los toques sobre lo que haya debajo
    transform: hs !== 1 ? `scaleX(${hs})` : '',
  });
}

/** Rellena el contenido de un elemento de texto (con un <span> por tramo de estilo). */
function fillTextEl(el, o) {
  el.textContent = '';
  if (o.runs) {
    for (const r of textRuns(o)) {
      const s = document.createElement('span');
      Object.assign(s.dataset, { f: r.family, b: r.bold ? '1' : '0', i: r.italic ? '1' : '0', c: r.color });
      Object.assign(s.style, {
        fontFamily: FONT_CSS[r.family] || FONT_CSS.sans, fontWeight: r.bold ? '700' : '400',
        fontStyle: r.italic ? 'italic' : 'normal', color: r.color,
      });
      s.textContent = r.text;
      el.appendChild(s);
    }
  } else {
    el.textContent = o.text || '';
  }
  // Una línea final vacía necesita un salto "de relleno" (igual que hace el navegador al pulsar Intro)
  if (o.text?.endsWith('\n')) el.appendChild(document.createTextNode('\n'));
  el.classList.toggle('is-empty', !o.text);
}

/** Crea una copia invisible y sin transformaciones de un texto para medirlo. */
function measureClone(o, pageW) {
  const el = document.createElement('div');
  el.className = 'obj obj-text';
  styleTextEl(el, o, pageW);
  fillTextEl(el, o);
  Object.assign(el.style, { left: '-100000px', top: '0', visibility: 'hidden', transform: 'none' });
  document.body.appendChild(el);
  return el;
}

/** Alto que ocupa el texto (sin la altura mínima de la caja). */
function naturalTextHeight(o, pageW) {
  const el = measureClone(o, pageW);
  const h = el.offsetHeight;
  el.remove();
  return h;
}

/**
 * Zona que ocupa el texto en sí (sin el alto extra de una caja estirada), medida sin depender de que esté dibujado:
 * es lo que decide hasta dónde llega la tapa de una línea original editada.
 */
export function textBox(o, pageW) {
  const el = measureClone(o, pageW);
  const r = el.getBoundingClientRect();
  const box = { x: o.x, y: o.y, w: r.width * hScale(o), h: r.height };
  el.remove();
  return box;
}

const COMBINING = /\p{M}/u;

/**
 * Reparte el texto en líneas tal y como se ve en pantalla (incluido el ajuste automático de líneas), con la
 * posición horizontal medida de cada trozo. Las medidas son de la caja sin escalar (hay que multiplicarlas por hScale).
 * @returns {Array<Array<{text, x, family, bold, italic, color}>>}
 */
export function layoutTextLines(o, pageW) {
  const el = measureClone(o, pageW);
  const left = el.getBoundingClientRect().left;
  const lineH = o.size * LH;
  const lines = [[]];
  const lineAt = (k) => { while (lines.length <= k) lines.push([]); return lines[k]; };
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let li = 0, lastTop = null, lastX = 0, piece = null, shy = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const d = n.parentElement.dataset;
    const st = d.f ? { family: d.f, bold: d.b === '1', italic: d.i === '1', color: d.c } : runStyle({}, o);
    const data = n.data;
    for (let i = 0; i < data.length;) {
      // Un carácter completo: un par sustituto (p. ej. un emoji) y las marcas que se combinan con él (acentos)
      const start = i;
      const c0 = data.charCodeAt(i);
      i += c0 >= 0xd800 && c0 <= 0xdbff && i + 1 < data.length ? 2 : 1;
      while (i < data.length && COMBINING.test(data[i])) i++;
      const ch = data.slice(start, i);
      if (ch === '\n') { li++; lastTop = null; piece = null; shy = null; continue; }
      range.setStart(n, start);
      range.setEnd(n, i);
      const rects = range.getClientRects();
      // Tras un corte en un guion blando, el primer rectángulo es el del guion: se usa el último
      const rect = rects[rects.length - 1];
      if (rect && lastTop !== null && rect.top > lastTop + lineH * 0.5) {
        // Salto de línea automático; si se cortó en un guion blando, éste se ve como "-" al final de la línea
        if (shy) lineAt(shy.li).push({ text: '-', x: shy.x, ...shy.st });
        li++;
        piece = null;
      }
      if (rect) lastTop = rect.top;
      const x = rect ? rect.left - left : lastX;
      const right = rect ? rect.right - left : x;
      if (rect) lastX = right;
      shy = null;
      if (ch === '\u00ad') { shy = { li, x, st }; piece = null; continue; }
      if (ch === '\t') { piece = null; continue; } // la tabulación se convierte en la posición del siguiente trozo
      // Cada palabra empieza en su posición medida, y los caracteres no ASCII van aparte con su ancho medido (su
      // ancho en pantalla puede no coincidir con el del PDF): así un desajuste nunca desplaza el resto de la línea
      const special = /[^\x20-\x7e]/.test(ch);
      if (piece && !special && !piece.special && !piece.endsWord && sameStyle(piece, st)) {
        piece.text += ch;
        piece.r = right;
        if (ch === ' ') piece.endsWord = true;
        continue;
      }
      piece = { text: ch, x, r: right, ...st, special, endsWord: ch === ' ' };
      lineAt(li).push(piece);
    }
  }
  el.remove();
  for (const line of lines) {
    for (const pc of line) {
      if (pc.special) pc.w = Math.max(0, pc.r - pc.x);
      else delete pc.special;
      delete pc.r;
      delete pc.endsWord;
    }
  }
  // Los espacios al final de cada línea no se ven
  for (const line of lines) {
    while (line.length) {
      const last = line[line.length - 1];
      last.text = last.text.replace(/\s+$/, '');
      if (last.text) break;
      line.pop();
    }
  }
  return lines;
}

/**
 * Zona de la que se quita el texto original de una línea editada: la propia línea y, si su texto pasa a ocupar más
 * líneas (por ajuste o por saltos de línea) y sigue encima de su sitio, también las líneas originales que quedan
 * debajo de ese texto, cada una entera (nunca se corta una línea por la mitad). Devuelve la tapa de la línea o, si
 * crece, el rectángulo que lo abarca todo con la lista de partes en `rects`.
 */
export function coverRect(o, box, lines = []) {
  const c = o.cover;
  if (!c || !box || o.annot) return c;
  const pad = c.pad ?? 1;
  const bottom = box.y + box.h + pad;
  // Sólo si el texto ocupa más de una línea y la caja sigue encima de su línea original (en vertical, y en horizontal
  // al menos en la mitad de la más estrecha de las dos): si se aparta, lo que había debajo de su sitio vuelve a verse
  const overlapX = Math.min(box.x + box.w, c.x + c.w) - Math.max(box.x, c.x);
  const stillThere = box.y <= c.y + c.h && box.y + box.h >= c.y && overlapX >= 0.5 * Math.min(box.w, c.w);
  if (!stillThere || bottom <= c.y + c.h + 0.5 * o.size) return c;
  const bx0 = box.x - pad, bx1 = box.x + box.w + pad;
  // Una línea de debajo cuyo centro (en horizontal y a la altura de sus letras, igual que al borrarlas del PDF) queda
  // bajo el texto se quita entera; las demás se quedan como están
  const rects = [{ x: c.x, y: c.y, w: c.w, h: c.h }];
  for (const l of lines) {
    if (l.key === o.lineKey || l.annot) continue;
    const center = l.baseline - 0.35 * l.size, mid = l.x + l.w / 2;
    if (center < c.y + c.h || center >= bottom || mid < bx0 || mid > bx1) continue;
    rects.push({ x: l.x - pad, y: l.top - pad, w: l.w + pad * 2, h: l.bottom - l.top + pad * 2 });
  }
  if (rects.length === 1) return c;
  const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w)), y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { ...c, x: x0, y: y0, w: x1 - x0, h: y1 - y0, rects };
}

/** Partes de una zona (las que devuelve coverRect). */
export const zoneParts = (z) => z.rects || [{ x: z.x, y: z.y, w: z.w, h: z.h }];

// ---------- Geometría ----------
function objNode(p, id) { return getEls(p.uid)?.objLayer.querySelector(`.obj[data-id="${id}"]`); }

export function getBBox(o, p) {
  switch (o.type) {
    case 'text': {
      const el = p && objNode(p, o.id);
      const hs = hScale(o);
      if (el && el.offsetWidth) {
        // Medida con decimales (offsetWidth redondea); el rectángulo ya incluye la escala horizontal y el zoom
        const r = el.getBoundingClientRect();
        const turned = p.rotation % 180 !== 0;
        const h = (turned ? r.width : r.height) / state.zoom;
        return { x: o.x, y: o.y, w: (turned ? r.height : r.width) / state.zoom, h: Math.max(o.h || 0, h) };
      }
      const lines = (o.text || ' ').split('\n');
      const w = o.w ?? Math.max(...lines.map((l) => l.length)) * o.size * 0.5 * hs + 4;
      return { x: o.x, y: o.y, w, h: Math.max(o.h || 0, lines.length * o.size * LH) };
    }
    case 'ink': {
      const xs = o.points.map((q) => q[0]), ys = o.points.map((q) => q[1]);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case 'line': case 'arrow':
      return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
    default:
      return { x: o.x, y: o.y, w: o.w, h: o.h };
  }
}

function translate(o, orig, dx, dy) {
  switch (o.type) {
    case 'ink': o.points = orig.points.map(([x, y]) => [x + dx, y + dy]); break;
    case 'line': case 'arrow':
      o.x1 = orig.x1 + dx; o.y1 = orig.y1 + dy; o.x2 = orig.x2 + dx; o.y2 = orig.y2 + dy; break;
    default: o.x = orig.x + dx; o.y = orig.y + dy;
  }
}

function applyBox(o, orig, ob, nb, handle) {
  switch (o.type) {
    case 'ink': {
      const sx = ob.w ? nb.w / ob.w : 1, sy = ob.h ? nb.h / ob.h : 1;
      o.points = orig.points.map(([x, y]) => [nb.x + (x - ob.x) * sx, nb.y + (y - ob.y) * sy]);
      break;
    }
    case 'text':
      // Se cambia el tamaño de la caja (el texto se ajusta a su ancho), no el de la letra
      o.x = nb.x;
      o.y = nb.y;
      if (/[ew]/.test(handle)) o.w = nb.w;
      if (/[ns]/.test(handle)) o.h = nb.h;
      break;
    default:
      Object.assign(o, nb);
  }
}

const keepsRatio = (o) => o.type === 'image';

/** Tiradores disponibles para cada tipo de objeto. */
function handleKinds(o) {
  if (o.type === 'line' || o.type === 'arrow') return ['p1', 'p2'];
  const corners = ['nw', 'ne', 'sw', 'se'];
  if (o.type === 'image' || o.type === 'ink') return corners;
  return [...corners, 'n', 's', 'e', 'w'];
}

/** Mantiene la línea base del texto al cambiar su tamaño o fuente (como hacen los editores de texto). */
function keepBaseline(o, change) {
  const base = o.y + textBaseline(o.family, o.size);
  change();
  o.y = base - textBaseline(o.family, o.size);
}

// ---------- Renderizado ----------
function shapeMarkup(o) {
  const op = o.opacity ?? 1;
  switch (o.type) {
    case 'rect':
      return `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="${o.fill || 'none'}" stroke="${o.color || 'none'}" stroke-width="${o.color ? o.width : 0}" opacity="${op}"/>`;
    case 'ellipse':
      return `<ellipse cx="${o.x + o.w / 2}" cy="${o.y + o.h / 2}" rx="${o.w / 2}" ry="${o.h / 2}" fill="${o.fill || 'none'}" stroke="${o.color || 'none'}" stroke-width="${o.color ? o.width : 0}" opacity="${op}"/>`;
    case 'highlight':
      return `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="${o.color}" stroke="none" opacity="${op}"/>`;
    case 'ink':
      return `<polyline points="${o.points.map((q) => q.join(',')).join(' ')}" fill="none" stroke="${o.color}" stroke-width="${o.width}" stroke-linecap="round" stroke-linejoin="round" opacity="${op}"/>`;
    case 'line':
      return `<line x1="${o.x1}" y1="${o.y1}" x2="${o.x2}" y2="${o.y2}" stroke="${o.color}" stroke-width="${o.width}" stroke-linecap="round" opacity="${op}"/>`;
    case 'arrow': {
      const h = arrowHead(o);
      return `<g opacity="${op}"><line x1="${o.x1}" y1="${o.y1}" x2="${h.base[0]}" y2="${h.base[1]}" stroke="${o.color}" stroke-width="${o.width}" stroke-linecap="round"/>` +
        `<polygon points="${[h.tip, h.left, h.right].map((q) => q.join(',')).join(' ')}" fill="${o.color}" stroke="none"/></g>`;
    }
  }
  return '';
}

const noop = () => {};

function buildObjEl(o, p) {
  const el = document.createElement('div');
  el.className = 'obj obj-' + o.type;
  el.dataset.id = o.id;
  // Así el objeto cuenta como "tocable": un toque sobre él no se desvía a un tirador o una línea cercanos
  el.addEventListener('click', noop);
  if (o.type === 'text') {
    styleTextEl(el, o, p?.w);
    fillTextEl(el, o);
    return el;
  }
  if (o.type === 'image') {
    Object.assign(el.style, { left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px', opacity: o.opacity ?? 1 });
    const img = document.createElement('img');
    img.src = state.assets[o.asset]?.src || '';
    img.draggable = false;
    img.alt = '';
    el.appendChild(img);
    return el;
  }
  const b = getBBox(o);
  const pad = (o.color ? (o.width || 0) / 2 : 0) + 2 + (o.type === 'arrow' ? arrowHead(o).L : 0);
  const vb = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  Object.assign(el.style, { left: vb.x + 'px', top: vb.y + 'px', width: vb.w + 'px', height: vb.h + 'px' });
  el.innerHTML = `<svg width="${vb.w}" height="${vb.h}" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}">${shapeMarkup(o)}</svg>`;
  return el;
}

function buildCoverEl(o) {
  const c = document.createElement('div');
  c.className = 'cover';
  c.dataset.for = o.id;
  Object.assign(c.style, { left: o.cover.x + 'px', top: o.cover.y + 'px', width: o.cover.w + 'px', height: o.cover.h + 'px', background: o.cover.color });
  return c;
}

/**
 * Ajusta la tapa provisional de una línea editada a lo que ocupa ahora su caja. La tapa sólo se ve hasta que su
 * zona se muestra ya como en la página modificada (ver refreshPatches), o si el texto original no se pudo quitar.
 */
function syncCover(p, o, refresh = true) {
  if (!o.cover) return;
  const node = getEls(p.uid)?.objLayer.querySelector(`.cover[data-for="${o.id}"]`);
  if (node) {
    const c = o.annot ? o.cover : coverRect(o, textBox(o, p.w), linesSync(p) || []);
    Object.assign(node.style, { left: c.x + 'px', top: c.y + 'px', width: c.w + 'px', height: c.h + 'px' });
  }
  if (refresh) refreshPatches(p);
}

// Las tapas cuya zona ya se ve como en la página modificada sobran; si la zona ha crecido, sólo hace falta tapar
// la parte nueva (ver refreshPatches)
on('patches', ({ p, status }) => {
  const layer = getEls(p.uid)?.objLayer;
  if (!layer) return;
  for (const node of layer.querySelectorAll('.cover')) {
    const st = status.get(node.dataset.for);
    if (!st) continue;
    node.hidden = !!st.hidden;
    if (st.rect) Object.assign(node.style, { left: st.rect.x + 'px', top: st.rect.y + 'px', width: st.rect.w + 'px', height: st.rect.h + 'px' });
  }
});

export function renderObjects(p) {
  const els = p && getEls(p.uid);
  if (!els) return;
  const layer = els.objLayer;
  if (editing && editing.p.uid === p.uid) finishEditing();
  layer.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const o of p.objects) if (o.cover) frag.appendChild(buildCoverEl(o));
  for (const o of p.objects) frag.appendChild(buildObjEl(o, p));
  layer.appendChild(frag);
  for (const o of p.objects) if (o.cover) syncCover(p, o, false);
  refreshPatches(p);
  if (state.selection?.uid === p.uid) renderSelection();
}

function updateObjEl(p, o) {
  // El texto que se está escribiendo se actualiza en su sitio para no perder el cursor
  if (editing?.o === o) {
    styleTextEl(editing.el, o, p.w);
  } else {
    const old = objNode(p, o.id);
    const el = buildObjEl(o, p);
    if (old) old.replaceWith(el);
    else getEls(p.uid)?.objLayer.appendChild(el);
  }
  syncCover(p, o);
}

export function renderSelection() {
  document.querySelectorAll('.sel').forEach((n) => n.remove());
  const s = state.selection;
  if (!s) return;
  const p = findPage(s.uid);
  const o = findObj(p, s.id);
  const els = p && getEls(p.uid);
  if (!o || !els) return;
  const b = getBBox(o, p);
  const isEditing = editing?.o === o;
  const textMode = (state.tool === 'text' || state.tool === 'edittext') && o.type === 'text';
  const sel = document.createElement('div');
  sel.className = 'sel' + (isEditing ? ' is-editing' : '');
  const box = document.createElement('div');
  box.className = 'sel-box';
  Object.assign(box.style, { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' });
  sel.appendChild(box);

  // Chrome desvía un toque al elemento "tocable" más cercano (p. ej. el texto en edición o una línea del PDF).
  // Un oyente de mousedown/click (y el estilo :active del CSS) hace que cada tirador cuente como tocable por sí mismo.
  const addHandle = (d, h) => {
    d.dataset.h = h;
    d.addEventListener('pointerdown', (e) => onHandleDown(e, p, h));
    d.addEventListener('mousedown', (e) => e.preventDefault());
    d.addEventListener('click', (e) => e.stopPropagation());
    sel.appendChild(d);
  };
  if ((state.tool === 'select' && !isEditing) || textMode) {
    let kinds = handleKinds(o);
    // En "Editar texto" las líneas están muy juntas: sin franjas arriba y abajo (el alto se cambia con las esquinas)
    if (state.tool === 'edittext') kinds = kinds.filter((h) => h !== 'n' && h !== 's');
    for (const h of kinds) {
      const d = document.createElement('div');
      d.className = 'handle';
      if (h === 'p1' || h === 'p2') {
        Object.assign(d.style, { left: (h === 'p1' ? o.x1 : o.x2) + 'px', top: (h === 'p1' ? o.y1 : o.y2) + 'px' });
      } else if (h.length === 2) {
        Object.assign(d.style, { left: b.x + (h[1] === 'e' ? b.w : 0) + 'px', top: b.y + (h[0] === 's' ? b.h : 0) + 'px' });
      } else {
        // Bordes: franjas a lo largo de cada lado, por fuera del contenido, para estirar o encoger la caja
        d.classList.add('edge');
        const t = 'var(--t)';
        Object.assign(d.style, {
          n: { left: b.x + 'px', top: `calc(${b.y}px - ${t})`, width: b.w + 'px', height: t },
          s: { left: b.x + 'px', top: b.y + b.h + 'px', width: b.w + 'px', height: t },
          w: { left: `calc(${b.x}px - ${t})`, top: b.y + 'px', width: t, height: b.h + 'px' },
          e: { left: b.x + b.w + 'px', top: b.y + 'px', width: t, height: b.h + 'px' },
        }[h]);
      }
      addHandle(d, h);
    }
  }
  // Pegados a la esquina superior izquierda de la página, el asa y el botón de borrar se saldrían de la vista:
  // entonces van debajo de la caja
  const below = b.x * state.zoom < 40 || b.y * state.zoom < 40;
  const anchor = { left: b.x + 'px', top: (below ? b.y + b.h : b.y) + 'px' };
  if (textMode) {
    // Asa para mover la caja mientras se edita
    const g = document.createElement('div');
    g.className = 'grip' + (below ? ' below' : '');
    g.title = t('Mover');
    g.innerHTML = '<svg><use href="#i-move"/></svg>';
    Object.assign(g.style, anchor);
    addHandle(g, 'move');
  }
  if (state.tool === 'select' || textMode) {
    // Botón para borrar el bloque: al lado del asa de mover (o en su sitio, si no la hay)
    const d = document.createElement('div');
    d.className = 'sel-del' + (below ? ' below' : '') + (textMode ? ' next' : '');
    d.title = t('Eliminar');
    d.setAttribute('role', 'button');
    d.setAttribute('aria-label', t('Eliminar'));
    d.innerHTML = '<svg><use href="#i-trash"/></svg>';
    Object.assign(d.style, anchor);
    d.addEventListener('pointerdown', onDeleteDown);
    d.addEventListener('mousedown', (e) => e.preventDefault());
    d.addEventListener('click', (e) => e.stopPropagation());
    sel.appendChild(d);
  }
  els.selLayer.appendChild(sel);
}

// ---------- Selección ----------
/** Al dejar de seleccionar una línea original abierta pero sin cambios, se deshace (el PDF queda intacto). */
function releaseSelection(nextId) {
  const s = state.selection;
  if (!s || s.id === nextId) return;
  const p = findPage(s.uid);
  const o = findObj(p, s.id);
  if (!o || editing?.o === o || !isNoopEdit(o)) return;
  p.objects.splice(p.objects.indexOf(o), 1);
  getEls(p.uid)?.objLayer.querySelectorAll(`.obj[data-id="${o.id}"], .cover[data-for="${o.id}"]`).forEach((n) => n.remove());
  refreshPatches(p);
  invalidateTextBoxes(p);
}

export function select(pageUid, id) {
  commitPendingStyle();
  releaseSelection(id);
  state.selection = { uid: pageUid, id };
  renderSelection();
  emit('selection');
}

export function deselect() {
  commitPendingStyle();
  if (!state.selection && !editing) return;
  finishEditing();
  releaseSelection(null);
  state.selection = null;
  renderSelection();
  emit('selection');
}

export function selectedObject() {
  const s = state.selection;
  if (!s) return null;
  const p = findPage(s.uid);
  const o = findObj(p, s.id);
  return o ? { p, o } : null;
}

// ---------- Arrastres ----------
let drag = null;
let suppressClickUntil = 0; // tras arrastrar, el "clic" que genera el navegador no debe crear ni cerrar nada
const touches = new Set();
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  touches.add(e.pointerId);
  if (touches.size > 1 && drag) drag.cancel();
}, true);
for (const t of ['pointerup', 'pointercancel']) document.addEventListener(t, (e) => touches.delete(e.pointerId), true);

function trackDrag(e, p, onMove, onEnd) {
  const id = e.pointerId;
  const move = (ev) => { if (ev.pointerId === id) onMove(ev); };
  const end = (ev) => {
    if (ev && ev.pointerId !== id) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    drag = null;
    onEnd(!ev || ev.type === 'pointercancel', ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  drag = { cancel: () => end(null) };
}

/** Registra un cambio en el historial; si se está escribiendo en ese texto, lo siguiente que se escriba será otro paso. */
function commit(o, snap) {
  checkpointFrom(snap);
  if (editing?.o === o) editing.snap = snapshot();
}

const DRAW_TOOLS = new Set(['pen', 'highlight', 'rect', 'ellipse', 'line', 'arrow', 'whiteout']);
export const isDrawTool = (t) => DRAW_TOOLS.has(t);

let lastTouch = null; // punto exacto del último dedo apoyado (el navegador puede desviar el evento a otro elemento)
const textTool = () => state.tool === 'text' || state.tool === 'edittext';
/** Elemento que hay exactamente en un punto, sin contar la capa de tiradores. */
const elementAt = (x, y) => document.elementsFromPoint(x, y).find((n) => !n.closest('.sel'));

/** Ejecuta fn si el dedo o el puntero se levanta casi sin moverse. */
function trackTap(e, fn) {
  const { pointerId: id, clientX: sx, clientY: sy } = e;
  let multi = false;
  const other = (ev) => { if (ev.pointerId !== id) multi = true; };
  const up = (ev) => {
    if (ev.pointerId !== id) return;
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    window.removeEventListener('pointerdown', other, true);
    // Si entretanto se apoyó otro dedo (p. ej. para pellizcar y hacer zoom), no era un toque
    if (!multi && ev.type === 'pointerup' && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) fn(ev);
  };
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  window.addEventListener('pointerdown', other, true);
}

/** Pulsación en el botón de borrar de la selección: borra al levantar el dedo (si no se ha deslizado). */
function onDeleteDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  if (touches.size > 1) return;
  trackTap(e, () => {
    // El clic que genera el navegador después ya no encuentra el botón: que no cree ni cierre nada
    suppressClickUntil = performance.now() + 400;
    deleteSelected();
  });
}

/** Pulsación en un tirador o en el asa de la selección (en cualquier herramienta). */
function onHandleDown(e, p, h) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.stopPropagation();
  if (touches.size > 1) return;
  const sel = selectedObject();
  if (!sel || sel.p !== p) return;
  e.preventDefault();
  if (h === 'move') startMove(e, p, sel.o, false, true);
  else startResize(e, p, h);
}

export function onPagePointerDown(e, pageUid) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.pointerType === 'touch') lastTouch = { x: e.clientX, y: e.clientY, t: performance.now() };
  if (touches.size > 1) return;
  const p = findPage(pageUid);
  if (!p) return;
  // Cuentagotas y cubo de relleno: actúan con un toque (si el dedo se desliza, sólo se desplaza la vista)
  if (pickCallback || state.tool === 'fill') {
    const picking = !!pickCallback;
    trackTap(e, (ev) => {
      // Si mientras tanto se canceló el cuentagotas o se cambió de herramienta, el toque ya no hace nada
      if (picking ? !pickCallback : state.tool !== 'fill') return;
      suppressClickUntil = performance.now() + 400;
      const pt = toLocal(p, ev.clientX, ev.clientY);
      if (pickCallback) {
        const cb = pickCallback;
        cancelColorPick();
        pickedAt = performance.now();
        cb(colorAt(p, pt.x, pt.y));
      } else {
        fillAt(p, pt, ev.pointerType === 'mouse' ? 2 : 8);
      }
    });
    return;
  }
  if (e.target.isContentEditable) {
    // Por si el navegador aún desvía al texto en edición un toque dirigido a un tirador cercano
    const h = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.matches?.('.handle, .grip, .sel-del'));
    if (h?.classList.contains('sel-del')) { onDeleteDown(e); return; }
    if (h) { onHandleDown(e, p, h.dataset.h); return; }
    // ...o un toque que en realidad cayó en otra línea u otro texto: se trata como un toque allí
    const real = e.pointerType === 'touch' && textTool() ? elementAt(e.clientX, e.clientY) : null;
    if (real && !e.target.contains(real) && real.closest('.tl-box, .obj-text')) {
      e.preventDefault();
      trackTap(e, (ev) => passThroughTap(ev));
    }
    return;
  }
  const handle = e.target.closest('.handle, .grip');
  if (handle) { onHandleDown(e, p, handle.dataset.h); return; }

  const node = e.target.closest('.obj');
  const tool = state.tool;
  if (tool === 'select') {
    if (node) {
      const o = findObj(p, node.dataset.id);
      if (!o) return;
      e.preventDefault();
      // Pulsar otro objeto termina la edición del texto anterior
      if (editing && editing.o !== o) finishEditing();
      const was = state.selection?.id === o.id;
      if (!was) select(p.uid, o.id);
      return startMove(e, p, o, was);
    }
    if (!e.target.closest('.sel')) deselect();
    return;
  }
  if (DRAW_TOOLS.has(tool)) {
    e.preventDefault();
    deselect();
    startDraw(e, p, tool);
  }
}

/** Los clics (no arrastres) sirven para crear/editar texto: así el foco no se pierde en pantallas táctiles. */
export function onPageClick(e, pageUid) {
  let target = e.target;
  if (e.pointerType !== 'mouse' && textTool() && lastTouch && performance.now() - lastTouch.t < 1500) {
    // Con el dedo cuenta lo que había exactamente bajo él (el navegador elige a veces una línea vecina)
    const real = elementAt(lastTouch.x, lastTouch.y);
    if (real?.closest('.page')) target = real;
  }
  const p = findPage(target.closest?.('.page')?.dataset.uid ?? pageUid);
  if (!p || target.isContentEditable || target.closest('.sel')) return;
  if (performance.now() < suppressClickUntil) return;
  const node = target.closest('.obj');
  const o = node && findObj(p, node.dataset.id);
  const tool = state.tool;

  if (tool === 'select') {
    if (!o) {
      // Con el dedo cuenta el punto exacto donde se apoyó (el navegador a veces desvía el toque)
      const touch = e.pointerType !== 'mouse' && lastTouch && performance.now() - lastTouch.t < 1500;
      selectLineAt(p, touch ? lastTouch.x : e.clientX, touch ? lastTouch.y : e.clientY);
    }
    return;
  }
  if (tool === 'text' || tool === 'edittext') {
    if (o && o.type === 'text') { select(p.uid, o.id); startEditing(p, o, null, e); return; }
    if (tool === 'edittext') {
      const box = target.closest('.tl-box');
      if (box) editLine(p, box.dataset.key, e);
      else {
        deselect();
        // Una foto o un escaneo no tiene texto dentro, solo la imagen: en la app de Android se reconoce (OCR);
        // si no, se explica qué se puede hacer (ver app.js)
        getLines(p).then((lines) => {
          if (!lines.length) emit('image-page', p);
        }).catch(() => {});
      }
      return;
    }
    // Un toque fuera de un texto en edición sólo termina la edición (y lo deselecciona)
    if (editing || performance.now() - lastFinish < 500) { deselect(); return; }
    createText(p, toLocal(p, e.clientX, e.clientY));
  }
}

/**
 * Un toque (sin arrastre) sobre un tirador cuenta como toque en lo que hay debajo: así los bordes de la caja
 * seleccionada no impiden abrir la línea de al lado.
 */
function passThroughTap(ev) {
  if (!ev) return;
  const stack = document.elementsFromPoint(ev.clientX, ev.clientY);
  // ¿Estaba el dedo realmente sobre el tirador, o el navegador le ha desviado un toque cercano?
  const onHandle = !!stack[0]?.closest('.sel');
  const onGrip = !!stack[0]?.closest('.grip');
  const under = stack.find((n) => !n.closest('.sel'));
  const pageEl = under?.closest('.page');
  const p = pageEl && findPage(pageEl.dataset.uid);
  if (!p) return;
  const node = under.closest('.obj');
  const o = node && findObj(p, node.dataset.id);
  // Con el dedo, un toque justo al lado del texto en edición coloca el cursor (con el ratón, no: se pulsó el
  // tirador; y el asa de mover nunca lo coloca)
  const caretHere = editing && (o === editing.o || (onHandle && !onGrip && !o && ev.pointerType !== 'mouse'));
  if (state.tool === 'select') {
    if (caretHere) { placeCaret(editing.el, ev); return; }
    // Tocar el texto seleccionado lo pone en edición; tocar otro objeto lo selecciona; tocar fuera deselecciona
    if (!o) { if (!onHandle) deselect(); return; }
    if (o.id !== state.selection?.id) select(p.uid, o.id);
    else if (o.type === 'text') startEditing(p, o, null, ev);
    return;
  }
  if (state.tool !== 'text' && state.tool !== 'edittext') return;
  // Otra línea u otro texto bajo el dedo: se abre
  const box = under.closest('.tl-box');
  if (box && state.tool === 'edittext') { editLine(p, box.dataset.key, ev); return; }
  if (o && o.type === 'text' && o !== editing?.o) { select(p.uid, o.id); startEditing(p, o, null, ev); return; }
  if (caretHere) { placeCaret(editing.el, ev); return; }
  if (onHandle) return;
  // Toque en una zona vacía de la página: lo mismo que un clic normal (termina la edición o crea un texto)
  if (editing || state.tool === 'edittext') deselect();
  else createText(p, toLocal(p, ev.clientX, ev.clientY));
}

/** Mueve un objeto; un toque sin arrastre sobre un texto ya seleccionado lo pone en edición. */
function startMove(e, p, o, wasSelected, fromGrip = false) {
  if (editing?.o === o) flushTyping();
  const snap = snapshot();
  const orig = structuredClone(o);
  const start = toLocal(p, e.clientX, e.clientY);
  let moved = false;
  trackDrag(e, p, (ev) => {
    const q = toLocal(p, ev.clientX, ev.clientY);
    const dx = q.x - start.x, dy = q.y - start.y;
    if (!moved && Math.hypot(dx, dy) * state.zoom < 4) return;
    moved = true;
    translate(o, orig, dx, dy);
    updateObjEl(p, o);
    renderSelection();
  }, (cancelled, ev) => {
    if (moved) {
      suppressClickUntil = performance.now() + 400;
      commit(o, snap);
    } else if (!cancelled && fromGrip) {
      passThroughTap(ev);
    } else if (!cancelled && wasSelected && o.type === 'text') {
      startEditing(p, o, null, ev);
    }
  });
}

function startResize(e, p, hd) {
  const sel = selectedObject();
  if (!sel || sel.p !== p) return;
  const { o } = sel;
  if (editing?.o === o) flushTyping();
  const snap = snapshot();
  const orig = structuredClone(o);
  const ob = getBBox(o, p);
  const isText = o.type === 'text';
  const minW = isText ? Math.max(8, o.size * 1.2) : 4;
  const minH = isText ? o.size * LH : 4;
  const start = toLocal(p, e.clientX, e.clientY);
  const sx = e.clientX, sy = e.clientY;
  let moved = false;
  trackDrag(e, p, (ev) => {
    // Hasta moverse unos píxeles no es un arrastre (un pequeño temblor del dedo no cambia nada)
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    moved = true;
    const q = toLocal(p, ev.clientX, ev.clientY);
    // Se aplica el desplazamiento del puntero al borde original, sin saltar al punto exacto donde se pulsó
    const dx = q.x - start.x, dy = q.y - start.y;
    if (hd === 'p1') { o.x1 = orig.x1 + dx; o.y1 = orig.y1 + dy; }
    else if (hd === 'p2') { o.x2 = orig.x2 + dx; o.y2 = orig.y2 + dy; }
    else {
      let l = ob.x, r = ob.x + ob.w, t = ob.y, b = ob.y + ob.h;
      if (hd.includes('w')) l += dx;
      if (hd.includes('e')) r += dx;
      if (hd.includes('n')) t += dy;
      if (hd.includes('s')) b += dy;
      if (keepsRatio(o) && hd.length === 2 && ob.w > 0 && ob.h > 0) {
        // Esquina de una imagen: se conserva la proporción respecto a la esquina opuesta
        const fx = hd.includes('w') ? ob.x + ob.w : ob.x;
        const fy = hd.includes('n') ? ob.y + ob.h : ob.y;
        const k = Math.max(minW / ob.w, minH / ob.h, Math.abs(r - l) / ob.w, Math.abs(b - t) / ob.h);
        const w = ob.w * k, h = ob.h * k;
        l = hd.includes('w') ? fx - w : fx;
        r = l + w;
        t = hd.includes('n') ? fy - h : fy;
        b = t + h;
      } else if (isText) {
        // Una caja de texto no se da la vuelta: el borde que se arrastra se detiene en el tamaño mínimo
        if (hd.includes('w')) l = Math.min(l, r - minW);
        if (hd.includes('e')) r = Math.max(r, l + minW);
        if (hd.includes('n')) t = Math.min(t, b - minH);
        if (hd.includes('s')) b = Math.max(b, t + minH);
      } else {
        if (l > r) [l, r] = [r, l];
        if (t > b) [t, b] = [b, t];
        r = Math.max(r, l + minW);
        b = Math.max(b, t + minH);
      }
      applyBox(o, orig, ob, { x: l, y: t, w: r - l, h: b - t }, hd);
      if (isText && /[ns]/.test(hd)) {
        // La caja nunca puede ser más baja que su texto
        const natural = naturalTextHeight(o, p.w);
        if (o.h < natural) {
          o.h = natural;
          if (hd.includes('n')) o.y = b - natural;
        }
      }
    }
    updateObjEl(p, o);
    renderSelection();
  }, (cancelled, ev) => {
    if (moved) {
      suppressClickUntil = performance.now() + 400;
      commit(o, snap);
      emit('selection');
    } else if (!cancelled) {
      passThroughTap(ev);
    }
  });
}

/** Vuelve a ajustar una caja de texto a su contenido. */
export function resetTextBox() {
  const sel = selectedObject();
  if (!sel || sel.o.type !== 'text' || (sel.o.w == null && sel.o.h == null)) return;
  if (editing?.o === sel.o) flushTyping();
  const snap = snapshot();
  delete sel.o.w;
  delete sel.o.h;
  updateObjEl(sel.p, sel.o);
  renderSelection();
  commit(sel.o, snap);
  emit('selection');
}

function startDraw(e, p, tool) {
  const s = state.style;
  const snap = snapshot();
  const pt = toLocal(p, e.clientX, e.clientY);
  let o;
  switch (tool) {
    case 'pen': o = { type: 'ink', points: [[pt.x, pt.y]], color: s.stroke, width: s.width, opacity: s.opacity }; break;
    case 'highlight': o = { type: 'highlight', x: pt.x, y: pt.y, w: 0, h: 0, color: s.hlcolor, opacity: 0.6 }; break;
    case 'whiteout': o = { type: 'rect', x: pt.x, y: pt.y, w: 0, h: 0, color: null, fill: s.whiteout, width: 0, opacity: 1, whiteout: true }; break;
    case 'rect': case 'ellipse':
      o = { type: tool, x: pt.x, y: pt.y, w: 0, h: 0, color: s.stroke, fill: s.fillOn ? s.fill : null, width: s.width, opacity: s.opacity }; break;
    default: o = { type: tool, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, color: s.stroke, width: s.width, opacity: s.opacity };
  }
  o.id = uid();
  p.objects.push(o);
  updateObjEl(p, o);
  if (tool === 'highlight') getLines(p); // precarga para "tocar una línea = resaltarla"

  trackDrag(e, p, (ev) => {
    const evs = ev.getCoalescedEvents?.().length ? ev.getCoalescedEvents() : [ev];
    for (const ce of evs) {
      const q = toLocal(p, ce.clientX, ce.clientY);
      if (o.type === 'ink') {
        const last = o.points[o.points.length - 1];
        if (Math.hypot(q.x - last[0], q.y - last[1]) * state.zoom >= 1.5) o.points.push([round(q.x), round(q.y)]);
      } else if (o.type === 'line' || o.type === 'arrow') {
        let { x, y } = q;
        if (ev.shiftKey) { // ángulos de 45º
          const a = Math.round(Math.atan2(y - o.y1, x - o.x1) / (Math.PI / 4)) * (Math.PI / 4);
          const d = Math.hypot(x - o.x1, y - o.y1);
          x = o.x1 + d * Math.cos(a); y = o.y1 + d * Math.sin(a);
        }
        o.x2 = x; o.y2 = y;
      } else {
        let w = q.x - pt.x, h = q.y - pt.y;
        if (ev.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
        o.x = Math.min(pt.x, pt.x + w); o.y = Math.min(pt.y, pt.y + h); o.w = Math.abs(w); o.h = Math.abs(h);
      }
    }
    updateObjEl(p, o);
  }, (cancelled) => {
    let ok = !cancelled;
    if (ok) {
      if (o.type === 'ink') { if (o.points.length === 1) o.points.push([o.points[0][0] + 0.01, o.points[0][1]]); }
      else if (o.type === 'line' || o.type === 'arrow') ok = Math.hypot(o.x2 - o.x1, o.y2 - o.y1) > 2;
      else if (o.w < 2 && o.h < 2) {
        ok = false;
        if (o.type === 'highlight') { // tocar una línea de texto la resalta entera
          const line = (linesSync(p) || []).find((l) => pt.x >= l.x && pt.x <= l.x + l.w && pt.y >= l.top && pt.y <= l.bottom);
          if (line) { Object.assign(o, { x: line.x, y: line.top, w: line.w, h: line.bottom - line.top }); ok = true; }
        }
      }
    }
    if (!ok) p.objects.splice(p.objects.indexOf(o), 1);
    renderObjects(p);
    if (ok) checkpointFrom(snap);
  });
}

const round = (v) => Math.round(v * 100) / 100;

// ---------- Cuentagotas y cubo de relleno ----------
let pickCallback = null;
let pickedAt = 0;

/** El siguiente toque en una página toma el color de ese punto y se lo pasa a `cb` (como el cuentagotas de Paint). */
export function startColorPick(cb) {
  pickCallback = cb;
  document.body.classList.add('picking');
}

export function cancelColorPick() {
  pickCallback = null;
  document.body.classList.remove('picking');
  document.querySelectorAll('#props .pick.on').forEach((b) => b.classList.remove('on'));
}

export const isPickingColor = () => !!pickCallback;

// Mientras se elige un color (y justo después, cuando el navegador simula el ratón tras un toque con el dedo), pulsar
// en la página no mueve el foco ni el cursor del texto que se está editando
document.addEventListener('mousedown', (e) => {
  if ((pickCallback || performance.now() - pickedAt < 800) && e.target.closest?.('.page')) e.preventDefault();
}, true);

/** Campo que pinta el cubo en cada tipo de objeto: el relleno de tapas y formas, el trazo del resto, el color del texto. */
function paintField(o) {
  if (o.type === 'image') return null;
  if (o.whiteout || o.type === 'rect' || o.type === 'ellipse') return 'fill';
  return 'color';
}

/** Pinta un objeto entero con un color (cubo de relleno). Devuelve false si no se puede pintar (imágenes). */
export function paintObject(p, o, color) {
  const field = paintField(o);
  if (!field) return false;
  const live = editing?.o === o;
  if (live) flushTyping();
  const snap = snapshot();
  if (o.type === 'text') {
    if (live) normalizeRuns(o, readRuns(editing.el, o));
    setTextField(o, 'color', color, null);
  } else {
    o[field] = color;
  }
  if (live) {
    fillTextEl(editing.el, o);
    styleTextEl(editing.el, o, p.w);
    syncCover(p, o);
  } else {
    updateObjEl(p, o);
  }
  renderSelection();
  commit(o, snap);
  emit('selection');
  return true;
}

/** Toque con el cubo de relleno: pinta el objeto que hay debajo con el color del cubo. */
function fillAt(p, pt, slopPx) {
  const o = hitObject(p, pt.x, pt.y, slopPx / state.zoom);
  if (!o) {
    // Un texto del documento no es un objeto todavía: hay que abrirlo antes para poder cambiarle el color
    const opened = new Set(p.objects.map((q) => q.lineKey).filter(Boolean));
    const onText = (linesSync(p) || []).some((l) => {
      if (opened.has(l.key)) return false; // ya abierta (y quizá vaciada o movida): ahí no queda su texto
      return (l.boxes || [{ x: l.x, y: l.top, w: l.w, h: l.bottom - l.top }])
        .some((b) => pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h);
    });
    emit('toast', onText
      ? t('Para cambiar el color de un texto del documento, ábrelo antes con «Editar texto».')
      : t('Toca una zona tapada, una forma, un dibujo o un texto añadido para pintarlo con este color.'));
    return;
  }
  if (!paintObject(p, o, state.style.bucket)) emit('toast', t('Las imágenes no se pueden rellenar.'));
}

// ---------- Edición de texto ----------
let editing = null; // { p, o, el, snap, parked, savedSel, lastAction, lastKind, typed }
let lastFinish = 0;
export const isEditingText = () => !!editing;
/** Se acaba de escribir (por si las siguientes teclas eran para el texto y no atajos de herramientas). */
export const justTyped = () => performance.now() - lastFinish < 1500;

// Se recuerda la selección dentro del texto para poder aplicar formato desde la barra de propiedades
document.addEventListener('selectionchange', () => {
  if (editing && !editing.parked && document.activeElement === editing.el) editing.savedSel = selectionOffsets(editing.el);
});

/** Lo escrito hasta ahora en la caja en edición pasa a ser un paso del historial (antes de otro tipo de cambio). */
function flushTyping() {
  if (!editing) return;
  normalizeRuns(editing.o, readRuns(editing.el, editing.o));
  checkpointFrom(editing.snap);
  editing.snap = snapshot();
}

/** Deja el texto en edición guardado en el documento (p. ej. antes de exportar) sin dejar de editarlo. */
export function syncEditing() {
  if (!editing) return;
  flushTyping();
  syncCover(editing.p, editing.o);
}

/** Deshacer/rehacer mientras se escribe: usa el historial de la aplicación y sigue editando la misma caja. */
function undoWhileEditing(isRedo) {
  const { p, o, el } = editing;
  const caret = selectionOffsets(el);
  // Lo escrito desde el último paso (también si se borró todo) pasa a ser un paso, para poder recuperarlo
  normalizeRuns(o, readRuns(el, o));
  const before = o.text;
  checkpointFrom(editing.snap);
  // Sin nada que deshacer o rehacer, se sigue escribiendo tal cual
  if (isRedo ? !canRedo() : !canUndo()) { editing.snap = snapshot(); return; }
  // Se deja de editar sin registrar ni borrar nada más: la página se redibuja enseguida con el estado restaurado
  editing = null;
  lastFinish = performance.now();
  el.contentEditable = 'false';
  if (isRedo) redo(); else undo();
  const p2 = findPage(p.uid);
  if (!p2) return;
  let o2 = findObj(p2, o.id);
  // Una línea original que vuelve a estar como al principio no se guarda en el historial: se vuelve a abrir
  if (!o2 && o.lineKey) {
    editLine(p2, o.lineKey, null);
    o2 = editing?.o;
  } else if (o2?.type === 'text') {
    select(p2.uid, o2.id);
    startEditing(p2, o2, null, null);
  }
  if (!editing || !o2) return;
  // El cursor va al final de la parte que ha cambiado (lo recuperado o donde estaba lo quitado);
  // si sólo cambió el formato, se queda donde estaba
  const after = o2.text, n = after.length;
  let at;
  if (after !== before) {
    let pre = 0;
    while (pre < before.length && pre < n && before[pre] === after[pre]) pre++;
    let suf = 0;
    while (suf < before.length - pre && suf < n - pre && before[before.length - 1 - suf] === after[n - 1 - suf]) suf++;
    at = [n - suf, n - suf];
  } else {
    at = caret ? [Math.min(caret[0], n), Math.min(caret[1], n)] : [n, n];
  }
  setSelectionOffsets(editing.el, at);
}

function createText(p, pt) {
  const s = state.style;
  const snap = snapshot();
  const o = {
    id: uid(), type: 'text', x: pt.x, y: pt.y - s.size * 0.6, size: s.size, family: s.family,
    bold: s.bold, italic: s.italic, color: s.textColor, text: '',
  };
  p.objects.push(o);
  renderObjects(p);
  select(p.uid, o.id);
  startEditing(p, o, snap, null);
}

function editLine(p, key, ev) {
  const existing = p.objects.find((o) => o.lineKey === key);
  if (existing) { select(p.uid, existing.id); startEditing(p, existing, null, ev); return; }
  const snap = snapshot();
  const o = openLine(p, key);
  if (!o) return;
  select(p.uid, o.id);
  startEditing(p, o, snap, ev);
}

/** Convierte una línea del PDF original en un texto del editor (todavía sin cambios) y lo devuelve. */
function openLine(p, key) {
  const line = (linesSync(p) || []).find((l) => l.key === key);
  if (!line) return null;
  const pad = Math.max(1, line.size * 0.08);
  let o;
  if (line.annot) {
    // Cuadro de texto añadido con otro programa (una anotación): conserva su fuente, tamaño y color; al guardar
    // con cambios, la anotación se sustituye por este texto
    o = {
      id: uid(), type: 'text', lineKey: key, annot: { ...line.annot }, text: line.text,
      x: line.x, y: line.baseline - textBaseline(line.family, line.size),
      size: line.size, family: line.family, bold: line.bold, italic: line.italic, color: line.color,
    };
    const tb = textBox(o, p.w);
    const { bg } = sampleColors(p, tb);
    o.cover = { x: tb.x - pad, y: tb.y - pad, w: tb.w + pad * 2, h: tb.h + pad * 2, color: bg, pad };
    // Con sus partes en negrita, cursiva o de otro color, si las tiene
    normalizeRuns(o, line.runs.map((r) => ({ ...r, color: r.color ?? line.color })));
  } else {
    const h = line.bottom - line.top;
    const { bg, fg } = sampleColors(p, { x: line.x, y: line.top, w: line.w, h });
    const runs = line.runs.map((r) => ({ ...r }));
    o = {
      id: uid(), type: 'text', lineKey: key, text: line.text,
      x: line.x, y: line.baseline - textBaseline(line.family, line.size),
      size: line.size, family: line.family, bold: line.bold, italic: line.italic, color: fg,
      orig: { runs, w: line.w, size: line.size },
      cover: { x: line.x - pad, y: line.top - pad, w: line.w + pad * 2, h: h + pad * 2, color: bg, pad },
    };
    normalizeRuns(o, runs.map((r) => ({ ...r, color: fg })));
    if (line.ocr) o.ocr = true; // texto de una imagen (OCR): al guardar, lo original se tapa
  }
  // Cómo estaba al abrirla: mientras siga igual, no cuenta como cambio (ver isNoopEdit)
  o.base = JSON.parse(JSON.stringify({
    text: o.text, runs: o.runs, x: o.x, y: o.y, size: o.size, family: o.family, bold: o.bold, italic: o.italic, color: o.color,
  }));
  p.objects.push(o);
  renderObjects(p);
  invalidateTextBoxes(p);
  return o;
}

/**
 * Con «Seleccionar», un toque en una línea del PDF original la selecciona como un bloque (igual que «Editar texto»):
 * luego se puede arrastrar, borrar o, con otro toque, editar. Arrastrar sobre texto sin seleccionar sigue
 * desplazando la página.
 */
async function selectLineAt(p, clientX, clientY) {
  const pt = toLocal(p, clientX, clientY);
  const lines = await getLines(p).catch(() => []);
  // Si entretanto se cambió de herramienta, se cerró el documento o se seleccionó otra cosa, ya no se hace nada
  if (state.tool !== 'select' || !state.pages.includes(p) || state.selection) return;
  const opened = new Set(p.objects.map((o) => o.lineKey).filter(Boolean));
  const tol = 6 / state.zoom; // un dedo no es tan preciso como el ratón
  let best = null;
  let bestD = Infinity;
  for (const l of lines) {
    if (opened.has(l.key)) continue;
    for (const b of l.boxes || [{ x: l.x, y: l.top, w: l.w, h: l.bottom - l.top }]) {
      const d = Math.hypot(Math.max(b.x - pt.x, 0, pt.x - b.x - b.w), Math.max(b.y - pt.y, 0, pt.y - b.y - b.h));
      if (d <= tol && d < bestD) { best = l; bestD = d; }
    }
  }
  if (!best) return;
  const o = openLine(p, best.key);
  if (o) select(p.uid, o.id);
}

export function startEditing(p, o, snap, ev) {
  if (editing?.o === o) { resumeEditing(); return; }
  finishEditing();
  const el = objNode(p, o.id);
  if (!el) return;
  editing = { p, o, el, snap: snap ?? snapshot(), parked: false, savedSel: null, lastAction: null };
  // "plaintext-only" evita que se cuelen formatos (negritas del navegador, HTML pegado...)
  try { el.contentEditable = 'plaintext-only'; } catch { el.contentEditable = 'true'; }
  if (!el.isContentEditable) el.contentEditable = 'true';
  el.spellcheck = false;
  el.classList.add('editing');
  el.focus({ preventScroll: true });
  placeCaret(el, ev);
  editing.savedSel = selectionOffsets(el);
  el.addEventListener('blur', (b) => {
    if (editing?.el !== el) return;
    // Si el foco pasa a la barra de formato, la edición queda "en pausa" para aplicar el formato al texto
    if (b.relatedTarget?.closest?.('#props')) { editing.parked = true; return; }
    finishEditing();
  });
  el.addEventListener('focus', () => { if (editing?.el === el) editing.parked = false; });
  // El navegador ajusta los toques del dedo y a veces deja el cursor un carácter antes del final: tras un toque
  // rápido se coloca donde estaba el dedo
  let tap = null;
  el.addEventListener('pointerdown', (d) => { tap = d.pointerType === 'touch' ? { x: d.clientX, y: d.clientY, t: performance.now() } : null; });
  el.addEventListener('pointerup', (u) => { if (tap && Math.hypot(u.clientX - tap.x, u.clientY - tap.y) >= 8) tap = null; });
  // El clic llega después de que el navegador haya colocado su cursor: se corrige con el punto exacto del dedo
  el.addEventListener('click', () => {
    const at = tap;
    tap = null;
    if (at && performance.now() - at.t < 800 && editing?.el === el && !window.getSelection()?.toString()) {
      placeCaret(el, { clientX: at.x, clientY: at.y });
    }
  });
  el.addEventListener('keydown', (k) => {
    const mod = k.ctrlKey || k.metaKey;
    const key = k.key.toLowerCase();
    // Deshacer/rehacer usa siempre el historial de la aplicación (por palabras, y también los cambios de formato)
    if (mod && !k.altKey && (key === 'z' || key === 'y') && editing?.el === el) {
      k.preventDefault();
      k.stopPropagation();
      undoWhileEditing(key === 'y' || k.shiftKey);
      return;
    }
    // Los atajos con Ctrl (guardar, buscar...) siguen funcionando mientras se escribe
    if (!mod) k.stopPropagation();
    if (k.key === 'Escape') {
      k.preventDefault();
      // Con el cuentagotas activo, Esc sólo lo cancela y se sigue escribiendo
      if (pickCallback) cancelColorPick();
      else el.blur();
    }
  });
  el.addEventListener('paste', (k) => {
    k.preventDefault();
    document.execCommand('insertText', false, k.clipboardData.getData('text/plain'));
  });
  el.addEventListener('beforeinput', (b) => {
    if (editing?.el !== el) return;
    // Pasar de escribir a borrar (o al revés), o escribir sobre una selección, empieza un paso nuevo del historial:
    // así lo borrado de la palabra que se estaba escribiendo se puede recuperar
    const kind = b.inputType.startsWith('delete') ? 'delete' : 'insert';
    const replacing = !window.getSelection()?.isCollapsed;
    // Cada palabra es un paso: el corte va antes del espacio o del salto de línea que la separa de la siguiente
    const wordBreak = b.inputType === 'insertParagraph' || b.inputType === 'insertLineBreak' ||
      (b.inputType === 'insertText' && /\s/.test(b.data || ''));
    if ((editing.lastKind && (kind !== editing.lastKind || replacing)) || wordBreak) flushTyping();
    editing.lastKind = kind;
  });
  el.addEventListener('input', (ev) => {
    el.classList.toggle('is-empty', !el.textContent);
    if (editing?.el === el) {
      editing.lastAction = 'type';
      // Si aún no había nada que deshacer, el primer carácter es un paso (así el botón Deshacer funciona enseguida)
      if (!editing.typed && !canUndo()) flushTyping();
      editing.typed = true;
      // La zona de la línea (lo que se quita del original) depende del texto que hay ahora en la caja
      normalizeRuns(o, readRuns(el, o));
    }
    syncCover(p, o);
    renderSelection();
  });
  renderSelection();
  emit('selection');
}

/** Devuelve el foco al texto en edición (tras usar la barra de formato), con la misma selección. */
export function resumeEditing() {
  if (!editing?.parked) return;
  const { el } = editing;
  el.focus({ preventScroll: true });
  setSelectionOffsets(el, editing.savedSel);
  editing.parked = false;
}

/** Posición del texto bajo un punto de la pantalla, sin que estorben los tiradores de la selección. */
function caretRangeAt(x, y) {
  const layers = [...document.querySelectorAll('.sel-layer')];
  layers.forEach((l) => { l.style.display = 'none'; });
  try {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    const pos = document.caretPositionFromPoint?.(x, y);
    if (!pos) return null;
    const r = document.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    return r;
  } finally {
    layers.forEach((l) => { l.style.display = ''; });
  }
}

/** Pone el cursor donde se tocó; si el toque cae justo fuera del texto, al principio o al final según el lado. */
function placeCaret(el, ev) {
  const sel = window.getSelection();
  let range = null;
  if (ev) {
    const r = caretRangeAt(ev.clientX, ev.clientY);
    if (r && el.contains(r.startContainer)) range = r;
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(el);
    const box = el.getBoundingClientRect();
    const atStart = ev && (ev.clientX - box.left) < box.width / 2 && ev.clientY < box.bottom;
    range.collapse(!!atStart);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

export function finishEditing() {
  if (!editing) return;
  const { p, o, el, snap } = editing;
  editing = null;
  lastFinish = performance.now();
  el.contentEditable = 'false';
  el.classList.remove('editing');
  // Si mientras tanto se abrió otro documento o se borró la página, la edición ya no cuenta
  if (!state.pages.includes(p)) return;
  normalizeRuns(o, readRuns(el, o));
  const idx = p.objects.indexOf(o);
  const selected = state.selection?.id === o.id;
  const s = window.getSelection();
  if (s?.rangeCount && el.contains(s.getRangeAt(0).startContainer)) s.removeAllRanges();
  // Sólo se actualiza este objeto: si se re-renderizara toda la capa, el clic que causó el blur perdería su destino.
  // Una línea original abierta sin cambios se conserva mientras siga seleccionada (para poder darle formato).
  if (idx >= 0 && ((!o.text.trim() && !o.cover) || (isNoopEdit(o) && !selected))) {
    p.objects.splice(idx, 1);
    if (selected) state.selection = null;
    el.remove();
    getEls(p.uid)?.objLayer.querySelector(`.cover[data-for="${o.id}"]`)?.remove();
    refreshPatches(p);
  } else {
    updateObjEl(p, o);
  }
  renderSelection();
  if (o.lineKey) invalidateTextBoxes(p);
  checkpointFrom(snap);
  emit('selection');
}

// ---------- Estilos y acciones sobre la selección ----------
const PROP_FIELD = {
  text: { family: 'family', size: 'size', bold: 'bold', italic: 'italic', textColor: 'color' },
  ink: { stroke: 'color', width: 'width', opacity: 'opacity' },
  line: { stroke: 'color', width: 'width', opacity: 'opacity' },
  arrow: { stroke: 'color', width: 'width', opacity: 'opacity' },
  rect: { stroke: 'color', width: 'width', opacity: 'opacity', fill: 'fill', fillOn: 'fill' },
  ellipse: { stroke: 'color', width: 'width', opacity: 'opacity', fill: 'fill', fillOn: 'fill' },
  highlight: { hlcolor: 'color' },
  image: { opacity: 'opacity' },
};

/** Aplica un campo de estilo a un texto: a la parte seleccionada si la hay, o a todo el texto. */
function setTextField(o, field, value, range) {
  const partial = range && range[1] > range[0] && RUN_FIELDS.has(field) && !(range[0] <= 0 && range[1] >= o.text.length);
  keepBaseline(o, () => {
    if (partial) {
      normalizeRuns(o, setRunsField(textRuns(o), range[0], range[1], field, value));
    } else {
      o[field] = value;
      if (o.runs && RUN_FIELDS.has(field)) normalizeRuns(o, o.runs.map((r) => ({ ...r, [field]: value })));
    }
  });
  // Si se elige otra fuente, se usa tal cual (sin imitar el ancho de la original); volver a la original lo deshace
  if (field === 'family') {
    const asOpened = o.base && o.family === o.base.family &&
      JSON.stringify((o.runs ?? []).map((r) => r.family)) === JSON.stringify((o.base.runs ?? []).map((r) => r.family));
    if (asOpened) delete o.noScale;
    else o.noScale = true;
  }
}

let pendingStyle = null;

/** Registra en el historial un cambio de estilo que aún se estaba ajustando (p. ej. un tamaño sin pulsar Intro). */
export function commitPendingStyle() {
  if (!pendingStyle) return;
  const { snap } = pendingStyle;
  pendingStyle = null;
  checkpointFrom(snap);
  if (editing) editing.snap = snapshot();
}

/** Olvida un cambio de estilo pendiente (al abrir otro documento: pertenece al anterior). */
export function discardPendingStyle() { pendingStyle = null; }

/** Cambia un estilo por defecto y, si hay un objeto seleccionado, se lo aplica. */
export function applyStyle(prop, value, final = true) {
  const sel = selectedObject();
  if (!sel) {
    setDefaultStyle(prop, value);
    if (final) commitPendingStyle();
    return;
  }
  const { p, o } = sel;
  let field = PROP_FIELD[o.type]?.[prop];
  if (o.whiteout && (prop === 'fill' || prop === 'fillOn')) field = 'fill';
  if (!field) { setDefaultStyle(prop, value); return; }

  // Texto en edición: se aplica en el sitio, conservando lo escrito y la selección
  const live = editing?.o === o;
  const range = live ? (editing.parked ? editing.savedSel : selectionOffsets(editing.el)) : null;
  if (live) normalizeRuns(o, readRuns(editing.el, o));
  const key = o.id + prop;
  if (pendingStyle?.key !== key) {
    if (pendingStyle) checkpointFrom(pendingStyle.snap);
    // Lo escrito antes y el cambio de formato son pasos distintos del historial
    if (live) flushTyping();
    pendingStyle = { key, snap: snapshot() };
  }
  state.style[prop] = value;
  styleChanged(prop);
  if (o.type === 'text') setTextField(o, field, value, range);
  else if (prop === 'fillOn') o.fill = value ? state.style.fill : null;
  else if (prop === 'fill') { if (o.fill || o.whiteout) o.fill = value; }
  else o[field] = value;
  if (o.whiteout && prop === 'fill') { state.style.whiteout = value; styleChanged('whiteout'); }

  if (live) {
    fillTextEl(editing.el, o);
    styleTextEl(editing.el, o, p.w);
    if (!editing.parked) setSelectionOffsets(editing.el, range);
    editing.lastAction = 'format';
    syncCover(p, o);
  } else {
    updateObjEl(p, o);
  }
  renderSelection();
  if (final) {
    checkpointFrom(pendingStyle.snap);
    pendingStyle = null;
    if (live) editing.snap = snapshot();
  }
}

/** Estilo de la parte seleccionada del texto (o de todo él): negrita, cursiva, y fuente y color si son únicos. */
export function textSelectionStyle() {
  const sel = selectedObject();
  if (!sel || sel.o.type !== 'text') return null;
  const o = sel.o;
  let runs;
  if (editing?.o === o) {
    normalizeRuns(o, readRuns(editing.el, o));
    runs = textRuns(o);
    const range = editing.parked ? editing.savedSel : selectionOffsets(editing.el);
    if (range && range[1] > range[0]) runs = runsInRange(runs, range);
  } else {
    runs = textRuns(o);
  }
  if (!runs.length) runs = [runStyle({}, o)];
  const one = (k) => (runs.every((r) => r[k] === runs[0][k]) ? runs[0][k] : null);
  return { bold: runs.every((r) => r.bold), italic: runs.every((r) => r.italic), family: one('family'), color: one('color') };
}

/** Estado de negrita/cursiva del texto seleccionado (o de todo el texto). */
export function textStyleState(prop) {
  const st = textSelectionStyle();
  return st ? st[prop] : !!state.style[prop];
}

/** Activa o desactiva negrita/cursiva (en la selección del texto o en todo él). */
export function toggleTextStyle(prop) {
  applyStyle(prop, !textStyleState(prop));
}

/** Aumenta o reduce el tamaño de letra del texto seleccionado. */
export function stepTextSize(delta) {
  const sel = selectedObject();
  const cur = sel?.o.type === 'text' ? sel.o.size : state.style.size;
  applyStyle('size', Math.min(200, Math.max(3, Math.round((cur + delta) * 2) / 2)));
}

export function deleteSelected() {
  finishEditing();
  const sel = selectedObject();
  if (!sel) return;
  const snap = snapshot();
  // Una línea (o un cuadro de texto) del PDF original se vacía: su tapa la quita del documento al guardar.
  // Si se quitara el objeto, volvería a verse el texto original.
  if (sel.o.cover) normalizeRuns(sel.o, []);
  else sel.p.objects.splice(sel.p.objects.indexOf(sel.o), 1);
  state.selection = null;
  renderObjects(sel.p);
  renderSelection(); // quita los tiradores y botones de la selección borrada
  if (sel.o.lineKey) invalidateTextBoxes(sel.p);
  checkpointFrom(snap);
  emit('selection');
}

export function duplicateSelected() {
  finishEditing();
  const sel = selectedObject();
  if (!sel) return;
  const snap = snapshot();
  const c = structuredClone(sel.o);
  c.id = uid();
  delete c.lineKey;
  delete c.ocr;
  delete c.cover;
  delete c.base;
  delete c.annot;
  translate(c, structuredClone(c), 12, 12);
  sel.p.objects.push(c);
  renderObjects(sel.p);
  select(sel.p.uid, c.id);
  checkpointFrom(snap);
}

export function nudgeSelected(dx, dy) {
  const sel = selectedObject();
  if (!sel) return;
  const snap = snapshot();
  translate(sel.o, structuredClone(sel.o), dx, dy);
  updateObjEl(sel.p, sel.o);
  renderSelection();
  checkpointFrom(snap);
}

/** Inserta una imagen (o firma) centrada en la parte visible de la página actual. */
export function addImage(assetId, { maxW = 0.45, signature = false } = {}) {
  const p = findPage(currentPageUid());
  const a = state.assets[assetId];
  if (!p || !a) return;
  const vr = viewerEl.getBoundingClientRect();
  let c = toLocal(p, vr.left + vr.width / 2, vr.top + vr.height / 2);
  c = { x: Math.min(p.w, Math.max(0, c.x)), y: Math.min(p.h, Math.max(0, c.y)) };
  let w = signature ? Math.min(170, p.w * 0.4) : Math.min(a.w * 0.75, p.w * maxW);
  let h = (w * a.h) / a.w;
  if (h > p.h * 0.6) { h = p.h * 0.6; w = (h * a.w) / a.h; }
  const snap = snapshot();
  const o = { id: uid(), type: 'image', asset: assetId, x: c.x - w / 2, y: c.y - h / 2, w, h, opacity: 1 };
  o.x = Math.min(p.w - w, Math.max(0, o.x));
  o.y = Math.min(p.h - h, Math.max(0, o.y));
  p.objects.push(o);
  renderObjects(p);
  checkpointFrom(snap);
  select(p.uid, o.id);
}
