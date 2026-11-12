// Extracción del texto original del PDF en líneas editables, muestreo de colores y búsqueda.
import { state } from './state.js';
import { getEls } from './viewer.js';
import { FONT_CSS, fontsReady } from './objects.js';
import { sourceLib } from './preview.js';
import { textOrigins } from './textremove.js';

const cache = new Map();    // "src:index" -> Promise<Line[]>
const resolved = new Map(); // "src:index" -> Line[]

export function getLines(p) {
  if (p.src == null) return Promise.resolve([]);
  const key = p.src + ':' + p.index;
  if (!cache.has(key)) {
    cache.set(key, extractLines(p)
      .then((lines) => { resolved.set(key, lines); return lines; })
      .catch((err) => { console.error(err); cache.delete(key); return []; }));
  }
  return cache.get(key);
}

/** Líneas ya extraídas (o null si aún no están listas). */
export const linesSync = (p) => (p.src == null ? [] : resolved.get(p.src + ':' + p.index) || null);

/**
 * Líneas reconocidas con OCR en una página que es una imagen (ver ocr.js): desde ese momento se editan, se
 * seleccionan y se buscan igual que las de un PDF normal.
 */
export function setOcrLines(p, lines) {
  const key = p.src + ':' + p.index;
  cache.set(key, Promise.resolve(lines));
  resolved.set(key, lines);
  // Los recuadros de las líneas de esa página (y de sus copias) se vuelven a crear
  for (const q of state.pages) {
    if (q.src !== p.src || q.index !== p.index) continue;
    const els = getEls(q.uid);
    if (els) els.textKey = null;
    if (state.tool === 'edittext') renderTextBoxes(q);
  }
}

function fontInfo(page, fontName, style) {
  let name = '', bold = false, italic = false;
  try {
    if (page.commonObjs.has(fontName)) {
      const f = page.commonObjs.get(fontName);
      name = f.name || '';
      bold = !!(f.bold || f.black);
      italic = !!f.italic;
    }
  } catch { /* fuente aún no disponible */ }
  const n = name.replace(/^[A-Z]{6}\+/, '');
  let family = style?.fontFamily === 'serif' ? 'serif' : style?.fontFamily === 'monospace' ? 'mono' : 'sans';
  if (/courier|mono|consol|menlo|typewriter/i.test(n)) family = 'mono';
  else if (/sans|arial|helvetica|verdana|tahoma|calibri|segoe|roboto|lato|gothic|futura|frutiger|myriad|univers/i.test(n)) family = 'sans';
  else if (/times|serif|georgia|garamond|cambria|palatino|bookman|minion|roman|baskerville|caslon/i.test(n)) family = 'serif';
  if (/bold|black|heavy|semibold|demi|[-,]bd\b/i.test(n)) bold = true;
  if (/italic|oblique|[-,]it\b/i.test(n)) italic = true;
  return { family, bold, italic };
}

async function extractLines(p) {
  const src = state.sources.get(p.src);
  const page = await src.pdf.getPage(p.index + 1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  try { await page.getOperatorList(); } catch { /* sólo sirve para cargar la info de fuentes */ }

  const fonts = {};
  const items = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    const t = pdfjsLib.Util.transform(vp.transform, it.transform);
    // Sólo texto horizontal, sin espejo. El inclinado (cursiva hecha inclinando las letras) cuenta como cursiva
    if (t[0] <= 0 || t[3] >= 0 || Math.abs(t[1]) > 0.02 * t[0] || Math.abs(t[2]) > 0.4 * Math.abs(t[3])) continue;
    const slanted = Math.abs(t[2]) > 0.02 * Math.abs(t[3]);
    const size = Math.abs(t[3]);
    if (size < 1 || it.width <= 0) continue;
    const st = tc.styles[it.fontName] || {};
    let asc = st.ascent, desc = st.descent;
    if (!(asc > 0.3 && asc < 1.5)) asc = 0.8;
    if (!(desc < 0 && desc > -0.8)) desc = -0.2;
    let f = (fonts[it.fontName] ||= fontInfo(page, it.fontName, st));
    if (slanted && !f.italic) f = { ...f, italic: true };
    items.push({
      str: it.str, x: t[4], base: t[5], size, w: it.width * vp.scale,
      top: t[5] - asc * size, bottom: t[5] - desc * size,
      fkey: f.family + (f.bold ? 'B' : '') + (f.italic ? 'I' : ''), font: f,
    });
  }

  // Agrupar en filas por línea base
  items.sort((a, b) => a.base - b.base || a.x - b.x);
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(it.base - row.base) <= 0.3 * Math.min(it.size, row.size)) row.items.push(it);
    else rows.push({ base: it.base, size: it.size, items: [it] });
  }

  // Subíndices y superíndices (más pequeños, a la altura de una línea mayor y junto a ella, como el 2 de H₂O): son
  // parte de esa línea. Si no, al editarla se borrarían del PDF sin estar en su texto
  const ext = rows.map((r) => ({
    top: Math.min(...r.items.map((i) => i.top)), bottom: Math.max(...r.items.map((i) => i.bottom)),
    x0: Math.min(...r.items.map((i) => i.x)), x1: Math.max(...r.items.map((i) => i.x + i.w)),
  }));
  rows.forEach((r, k) => {
    r.items = r.items.filter((it) => {
      const c = it.base - 0.35 * it.size;
      const m = rows.findIndex((q, j) => j !== k && it.size <= 0.85 * q.size && c >= ext[j].top && c <= ext[j].bottom &&
        it.x <= ext[j].x1 + q.size && it.x + it.w >= ext[j].x0 - q.size);
      if (m < 0) return true;
      rows[m].items.push({ ...it, script: true });
      return false;
    });
  });

  // Dentro de cada fila, separar en segmentos por huecos grandes o tamaños distintos.
  // Los cambios de estilo (negrita, cursiva, otra fuente) dentro de un segmento se guardan como "tramos".
  const lines = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let seg = null;
    for (const it of row.items) {
      const gap = seg ? it.x - seg.right : 0;
      // Un subíndice o superíndice se une a lo que tenga al lado aunque su tamaño sea otro
      const sized = it.script || seg?.scriptOnly || Math.abs(it.size - seg?.size) <= 0.05 * seg?.size;
      const same = seg && sized && gap <= Math.max(seg.size, it.size) * 1.1 && gap >= -Math.max(seg.size, it.size) * 0.6;
      if (same) {
        if (seg.scriptOnly && !it.script) Object.assign(seg, { scriptOnly: false, size: it.size, base: it.base });
        const sep = gap > seg.size * 0.12 && !/\s$/.test(seg.text) && !/^\s/.test(it.str) ? ' ' : '';
        const last = seg.runs[seg.runs.length - 1];
        if (last.fkey === it.fkey) last.text += sep + it.str;
        else { last.text += sep; seg.runs.push({ fkey: it.fkey, ...it.font, text: it.str }); }
        seg.text += sep + it.str;
        seg.right = Math.max(seg.right, it.x + it.w);
        seg.top = Math.min(seg.top, it.top);
        seg.bottom = Math.max(seg.bottom, it.bottom);
      } else {
        seg = {
          text: it.str, x: it.x, right: it.x + it.w, base: it.base, size: it.size, top: it.top, bottom: it.bottom,
          runs: [{ fkey: it.fkey, ...it.font, text: it.str }], scriptOnly: !!it.script,
        };
        lines.push(seg);
      }
    }
  }

  const out = lines
    .filter((s) => s.text.trim())
    .map((s, i) => {
      const last = s.runs[s.runs.length - 1];
      last.text = last.text.replace(/\s+$/, '');
      const runs = s.runs.filter((r) => r.text).map(({ text, family, bold, italic }) => ({ text, family, bold, italic }));
      // Estilo principal: el del tramo más largo
      const main = runs.reduce((a, b) => (b.text.length > a.text.length ? b : a), runs[0]);
      return {
        key: 'L' + i, text: runs.map((r) => r.text).join(''), runs,
        family: main.family, bold: main.bold, italic: main.italic,
        x: s.x, w: s.right - s.x, baseline: s.base, size: Math.round(s.size * 100) / 100, top: s.top, bottom: s.bottom,
      };
    });

  // Cuadros de texto añadidos con otros programas (anotaciones de texto libre, p. ej. "Agregar texto" de Edge o
  // Acrobat): no forman parte del contenido de la página, pero se editan igual que sus líneas
  let annots = [];
  try { annots = await page.getAnnotations({ intent: 'display' }); } catch { /* sin anotaciones */ }
  annots = annots.filter((a) => a.subtype === 'FreeText');
  if (annots.length) {
    await fontsReady; // para medir su texto
    const raw = await rawAnnotInfo(p, annots);
    for (const a of annots) {
      const info = raw.get(a.id) || {};
      const l = !info.callout && annotLine(a, vp, info);
      if (l) out.push(l);
    }
  }
  return out;
}

/** Fuente (familia, negrita, cursiva) a partir de su nombre. */
function fontFromName(n) {
  n = String(n || '').replace(/^[A-Z]{6}\+/, '');
  let family = 'sans';
  if (/courier|mono|consol/i.test(n)) family = 'mono';
  else if (!/sans|arial|helv/i.test(n) && /times|serif|roman|georgia|garamond|cambria|palatino|minion|book/i.test(n)) family = 'serif';
  return { family, bold: /bold|black|heavy|semibold|demi/i.test(n), italic: /italic|oblique/i.test(n) };
}

const numsOf = (o) => (o?.asArray ? o.asArray().map((v) => (typeof v?.asNumber === 'function' ? v.asNumber() : NaN)) : null);

/**
 * Lo que pdf.js no da de cada anotación de texto, leído del propio PDF: si es una "llamada" (con una flecha que señala
 * algo; no se edita, porque al sustituirla por texto se perdería la flecha), la fuente con la que está dibujada (la de
 * su apariencia, que es la que se ve) y dónde empieza cada fila de texto (en coordenadas de la página PDF).
 */
async function rawAnnotInfo(p, annots) {
  const out = new Map();
  try {
    const lib = await sourceLib(p.src);
    const { PDFRef, PDFName, PDFDict, PDFRawStream, decodePDFRawStream } = PDFLib;
    for (const a of annots) {
      const m = /^(\d+)R(\d*)$/.exec(a.id || '');
      if (!m) continue;
      const d = lib.context.lookup(PDFRef.of(+m[1], +(m[2] || 0)));
      if (!(d instanceof PDFDict)) continue;
      const it = d.get(PDFName.of('IT'));
      const info = { callout: !!d.get(PDFName.of('CL')) || it?.toString() === '/FreeTextCallout' };
      try {
        const ap = d.lookup(PDFName.of('AP'));
        const n = ap instanceof PDFDict ? ap.lookup(PDFName.of('N')) : null;
        if (n instanceof PDFRawStream) {
          const bytes = decodePDFRawStream(n).decode();
          // Primera fuente que usa la apariencia
          const src = new TextDecoder('latin1').decode(bytes);
          const tf = /\/([^\s/[\]()<>{}%]+)\s+[-\d.]+\s+Tf/.exec(src);
          const fonts = n.dict.lookup(PDFName.of('Resources'))?.lookup?.(PDFName.of('Font'));
          const f = tf && fonts instanceof PDFDict ? fonts.lookup(PDFName.of(tf[1])) : null;
          const base = f instanceof PDFDict ? f.lookup(PDFName.of('BaseFont')) : null;
          if (base instanceof PDFName) info.baseFont = base.asString().slice(1);
          // Inicio de cada fila: del espacio de la apariencia (con su matriz) al rectángulo de la anotación
          const bb = numsOf(n.dict.lookup(PDFName.of('BBox'))) || [0, 0, 1, 1];
          const mt = numsOf(n.dict.lookup(PDFName.of('Matrix'))) || [1, 0, 0, 1, 0, 0];
          const r = numsOf(d.lookup(PDFName.of('Rect')));
          if (r?.length === 4 && bb.every(Number.isFinite) && mt.every(Number.isFinite)) {
            const M = ([x, y]) => [mt[0] * x + mt[2] * y + mt[4], mt[1] * x + mt[3] * y + mt[5]];
            const c = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]].map(M);
            const bx0 = Math.min(...c.map((q) => q[0])), bx1 = Math.max(...c.map((q) => q[0]));
            const by0 = Math.min(...c.map((q) => q[1])), by1 = Math.max(...c.map((q) => q[1]));
            const rx0 = Math.min(r[0], r[2]), rx1 = Math.max(r[0], r[2]), ry0 = Math.min(r[1], r[3]), ry1 = Math.max(r[1], r[3]);
            const sx = bx1 > bx0 ? (rx1 - rx0) / (bx1 - bx0) : 1, sy = by1 > by0 ? (ry1 - ry0) / (by1 - by0) : 1;
            const toPage = (q) => { const [x, y] = M(q); return [rx0 + (x - bx0) * sx, ry0 + (y - by0) * sy]; };
            const rows = [];
            for (const [x, y] of textOrigins(bytes).map(toPage)) {
              const row = rows.find((q) => Math.abs(q.y - y) < 1);
              if (row) row.x = Math.min(row.x, x); else rows.push({ x, y });
            }
            info.rows = rows.sort((q, w) => w.y - q.y); // de arriba abajo
          }
        }
      } catch { /* sin apariencia legible */ }
      out.set(a.id, info);
    }
  } catch { /* sin acceso al PDF original: se tratan como cuadros normales */ }
  return out;
}

// Nombres abreviados de las fuentes estándar en los formularios y anotaciones (/DA)
const DA_FONTS = {
  Helv: ['sans', 0, 0], HeBo: ['sans', 1, 0], HeOb: ['sans', 0, 1], HeBO: ['sans', 1, 1],
  TiRo: ['serif', 0, 0], TiBo: ['serif', 1, 0], TiIt: ['serif', 0, 1], TiBI: ['serif', 1, 1],
  Cour: ['mono', 0, 0], CoBo: ['mono', 1, 0], CoOb: ['mono', 0, 1], CoBO: ['mono', 1, 1],
};

const HIDDEN = 0x02, NOVIEW = 0x20; // indicadores de anotación ocultos

const colorCtx = document.createElement('canvas').getContext('2d');
/** Color CSS (#rgb, #rrggbb, rgb(...) o por nombre, como "red") como #rrggbb, o null. */
function cssColor(v) {
  const s = String(v || '').trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return '#' + m[1].toLowerCase();
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m) return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
  m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s);
  if (m) return hex(+m[1], +m[2], +m[3]);
  if (!/^[a-z]+$/i.test(s)) return null;
  // Un nombre de color: el lienzo lo traduce (si no lo conoce, deja el valor anterior)
  colorCtx.fillStyle = '#010203';
  colorCtx.fillStyle = s;
  const out = colorCtx.fillStyle;
  return out !== '#010203' && /^#[0-9a-f]{6}$/i.test(out) ? out.toLowerCase() : null;
}

const flat = (s) => s.replace(/\s+/g, '');

/**
 * Tramos de estilo del texto enriquecido (/RC) de una anotación: negrita, cursiva, color y fuente de cada parte.
 * Devuelve null si no hay o si su texto no coincide con el que se ve.
 */
function richRuns(rich, text, base) {
  if (!rich?.html) return null;
  const runs = [];
  const push = (t, st) => {
    if (!t) return;
    const last = runs[runs.length - 1];
    if (last && last.bold === st.bold && last.italic === st.italic && last.color === st.color && last.family === st.family) last.text += t;
    else runs.push({ text: t, ...st });
  };
  const walk = (node, st, top) => {
    if (!node || typeof node !== 'object') return;
    const css = node.attributes?.style || {};
    const s2 = { ...st };
    if (/^(b|strong)$/i.test(node.name || '')) s2.bold = true;
    if (/^(i|em)$/i.test(node.name || '')) s2.italic = true;
    if (css.fontWeight) s2.bold = /bold|[6-9]00/i.test(String(css.fontWeight));
    if (css.fontStyle) s2.italic = /italic|oblique/i.test(String(css.fontStyle));
    const col = cssColor(css.color);
    if (col) s2.color = col;
    if (css.fontFamily) s2.family = fontFromName(css.fontFamily).family;
    // Cada párrafo empieza en una línea nueva
    if (!top && node.name === 'p' && runs.length && !runs[runs.length - 1].text.endsWith('\n')) push('\n', s2);
    if (typeof node.value === 'string') push(node.value, s2);
    for (const c of node.children || []) walk(c, s2, false);
  };
  walk(rich.html, base, true);
  if (!runs.length || flat(runs.map((r) => r.text).join('')) !== flat(text)) return null;
  // Se reparte el texto que se ve (con sus saltos de línea) entre los tramos, en el mismo orden
  const out = [];
  let i = 0;
  for (const r of runs) {
    const n = flat(r.text).length;
    let piece = '', taken = 0;
    while (i < text.length && (taken < n || /\s/.test(text[i]))) {
      if (!/\s/.test(text[i])) { if (taken === n) break; taken++; }
      piece += text[i++];
    }
    if (piece) out.push({ ...r, text: piece });
  }
  if (i < text.length && out.length) out[out.length - 1].text += text.slice(i);
  return out.length ? out : null;
}

/**
 * Filas del texto: las de la apariencia (lo que se ve, con las líneas que parte el ajuste automático), más las
 * líneas en blanco de su contenido (/Contents), que la apariencia no muestra. Si no encajan, las de la apariencia.
 */
function textRows(shown, contents) {
  if (!shown.length) return contents;
  if (!contents.length) return shown;
  const out = [];
  let j = 0;
  for (const c of contents) {
    if (!c.trim()) { out.push(''); continue; }
    let acc = '';
    while (j < shown.length && flat(acc).length < flat(c).length) { acc += shown[j]; out.push(shown[j++]); }
    if (flat(acc) !== flat(c)) return shown;
  }
  return j === shown.length ? out : shown;
}

/** Línea editable a partir de una anotación de texto libre (o null si no se puede editar). */
function annotLine(a, vp, info = {}) {
  // Sólo las que se ven derechas: en una página girada (o si la propia anotación está girada) se verían de lado
  if (a.subtype !== 'FreeText' || !a.hasAppearance || a.rotation || vp.rotation || !/^\d+R\d*$/.test(a.id || '')) return null;
  if (a.annotationFlags & (HIDDEN | NOVIEW)) return null;
  // Los cuadros con borde o fondo de color no: al sustituirlos por texto se perderían
  if (a.borderStyle?.width > 0 || a.color?.length) return null;
  const clean = (rows) => {
    rows = rows.map((r) => r.replace(/\u00a0/g, ' ').replace(/\s+$/, ''));
    while (rows.length && !rows[rows.length - 1]) rows.pop();
    return rows;
  };
  const shown = clean(a.textContent?.length ? [...a.textContent] : []);
  const contents = clean(String(a.contentsObj?.str || '').replace(/\r\n?/g, '\n').split('\n'));
  const rows = textRows(shown, contents);
  const text = rows.join('\n');
  if (!text.trim()) return null;

  const da = a.defaultAppearanceData || {};
  const size = da.fontSize > 0 && da.fontSize < 200 ? Math.round(da.fontSize * 100) / 100 : 12;
  const rich = a.richText ? JSON.stringify(a.richText) : '';
  // Fuente: la del texto enriquecido; si no, la abreviada estándar del /DA; si no, la de su apariencia o su nombre.
  // La negrita y la cursiva de la fuente con la que está dibujada la apariencia cuentan siempre
  const richFamily = rich.match(/font-?family\W+([^"';,]+)/i)?.[1];
  const std = DA_FONTS[da.fontName];
  let font;
  if (richFamily) font = fontFromName(richFamily);
  else if (std) font = { family: std[0], bold: !!std[1], italic: !!std[2] };
  else font = fontFromName(info.baseFont || da.fontName);
  if (info.baseFont) {
    const af = fontFromName(info.baseFont);
    font = { ...font, bold: font.bold || af.bold, italic: font.italic || af.italic };
  }
  const fc = da.fontColor;
  const color = fc && fc.length !== 0 && fc[0] != null ? hex(fc[0], fc[1], fc[2]) : '#000000';
  const runs = richRuns(a.richText, text, { family: font.family, bold: font.bold, italic: font.italic, color })
    || [{ text, family: font.family, bold: font.bold, italic: font.italic }];
  // El estilo principal es el del tramo más largo
  const main = runs.reduce((x, y) => (y.text.length > x.text.length ? y : x), runs[0]);

  const r = vp.convertToViewportRectangle(a.rect);
  const left = Math.min(r[0], r[2]), right = Math.max(r[0], r[2]);
  const top = Math.min(r[1], r[3]), bottom = Math.max(r[1], r[3]);
  if (right - left < 1 || bottom - top < 1) return null;
  const widths = rows.map((row) => textWidth(row, main.family, main.bold, main.italic, size));
  // Dónde empieza cada fila: la apariencia lo dice (una posición por fila con texto); si no encaja, la primera es la
  // que da pdf.js y las demás van debajo, con el interlineado habitual
  const filled = rows.map((row, k) => (row.trim() ? k : -1)).filter((k) => k >= 0);
  const pos = new Array(rows.length).fill(null);
  if (info.rows?.length === filled.length) {
    filled.forEach((k, i) => {
      const [px, py] = vp.convertToViewportPoint(info.rows[i].x, info.rows[i].y);
      pos[k] = { x: px, base: py };
    });
  } else {
    let x = left + 2, base = top + 2 + size * 0.9;
    if (a.textPosition) {
      const [px, py] = vp.convertToViewportPoint(a.rect[0] + a.textPosition[0], a.rect[1] + a.textPosition[1]);
      if (px >= left - 2 && px <= right && py >= top && py <= bottom + 2) { x = px; base = py; }
    }
    pos[0] = { x, base };
  }
  // Las filas sin posición (en blanco, o todas menos la primera si no se conoce más): con el paso de las de alrededor
  const known = pos.map((q, k) => (q ? k : -1)).filter((k) => k >= 0);
  const gaps = known.slice(1).map((k, i) => (pos[k].base - pos[known[i]].base) / (k - known[i])).filter((g) => g > 0);
  const pitch = gaps.length ? gaps.sort((u, v) => u - v)[gaps.length >> 1] : size * 1.15;
  for (let k = 0; k < rows.length; k++) {
    if (pos[k]) continue;
    const prev = known.filter((j) => j < k).pop();
    const ref = prev !== undefined ? prev : known[0];
    pos[k] = { x: pos[ref].x, base: pos[ref].base + (k - ref) * pitch };
  }
  const rowInfo = rows.map((row, k) => ({ text: row, x: pos[k].x, w: widths[k], y: pos[k].base - size * 0.8, h: size * 1.02 }));
  // Lo que se toca es el texto de cada fila, no todo el cuadro de la anotación (que suele ser mucho más ancho y
  // taparía las palabras de al lado)
  const boxes = rowInfo.filter((q) => q.text.trim()).map((q) => ({ x: q.x - 1, y: q.y, w: q.w + 2, h: q.h }));
  const bx0 = Math.min(...boxes.map((b) => b.x)), bx1 = Math.max(...boxes.map((b) => b.x + b.w));
  const by0 = Math.min(...boxes.map((b) => b.y)), by1 = Math.max(...boxes.map((b) => b.y + b.h));
  const x = pos[0].x, baseline = pos[0].base;
  return {
    key: 'A' + a.id, annot: { ref: a.id, x: left, y: top, w: right - left, h: bottom - top },
    boxes, box: { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 }, rows: rowInfo,
    text, runs: runs.map(({ text: t, family: f, bold: b, italic: i, color: c }) => ({ text: t, family: f, bold: b, italic: i, ...(c ? { color: c } : {}) })),
    family: main.family, bold: main.bold, italic: main.italic, color: main.color || color,
    x, w: Math.max(1, bx1 - x), baseline, size, top: by0, bottom: by1,
  };
}

const measureCtx = document.createElement('canvas').getContext('2d');
/** Ancho de un texto con la fuente de pantalla (la misma que usará al editarlo). */
function textWidth(text, family, bold, italic, size) {
  measureCtx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${FONT_CSS[family] || FONT_CSS.sans}`;
  return measureCtx.measureText(text).width;
}

/** Dibuja los recuadros de líneas editables (modo "Editar texto"). */
export async function renderTextBoxes(p) {
  const els = getEls(p.uid);
  if (!els) return;
  const lines = await getLines(p);
  const key = p.src + ':' + p.index;
  // Los recuadros se crean una sola vez y luego sólo se ocultan/muestran (así un clic nunca pierde su destino)
  if (els.textKey !== key) {
    els.textKey = key;
    els.textLayer.innerHTML = '';
    const frag = document.createDocumentFragment();
    // Los cuadros de las anotaciones van al final: así quedan por encima del texto de la página que tapen
    for (const l of lines) {
      // Una anotación de varias filas tiene una caja por fila (todas abren la misma)
      for (const b of l.boxes || [{ x: l.x, y: l.top, w: l.w, h: l.bottom - l.top }]) {
        const d = document.createElement('div');
        d.className = 'tl-box';
        d.dataset.key = l.key;
        d.title = l.text;
        d.style.left = b.x - 1 + 'px';
        d.style.top = b.y - 1 + 'px';
        d.style.width = b.w + 2 + 'px';
        d.style.height = b.h + 2 + 'px';
        frag.appendChild(d);
      }
    }
    els.textLayer.appendChild(frag);
  }
  syncTextBoxes(p);
}

function syncTextBoxes(p) {
  const els = getEls(p.uid);
  if (!els) return;
  const edited = new Set(p.objects.filter((o) => o.lineKey).map((o) => o.lineKey));
  for (const d of els.textLayer.children) d.hidden = edited.has(d.dataset.key);
}

export function invalidateTextBoxes(p) {
  syncTextBoxes(p);
}

// ---------- Colores ----------
const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Estima el color de fondo y el del texto de un recuadro a partir del lienzo renderizado. */
export function sampleColors(p, box) {
  const fallback = { bg: '#ffffff', fg: '#000000' };
  const els = getEls(p.uid);
  const c = els?.canvas;
  if (!c || !c.width || !els.renderedScale) return fallback; // aún sin dibujar: el lienzo está vacío
  const k = c.width / p.w;
  const pad = 2;
  const x0 = Math.max(0, Math.floor((box.x - pad) * k));
  const y0 = Math.max(0, Math.floor((box.y - pad) * k));
  const x1 = Math.min(c.width, Math.ceil((box.x + box.w + pad) * k));
  const y1 = Math.min(c.height, Math.ceil((box.y + box.h + pad) * k));
  const w = x1 - x0, h = y1 - y0;
  if (w < 3 || h < 3) return fallback;
  let data;
  try { data = c.getContext('2d').getImageData(x0, y0, w, h).data; } catch { return fallback; }

  // Fondo: color más frecuente en el borde
  const buckets = new Map();
  const add = (i) => {
    const key = (data[i] >> 4) << 8 | (data[i + 1] >> 4) << 4 | (data[i + 2] >> 4);
    const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
    buckets.set(key, b);
  };
  for (let x = 0; x < w; x++) { add(x * 4); add(((h - 1) * w + x) * 4); }
  for (let y = 0; y < h; y++) { add(y * w * 4); add((y * w + w - 1) * 4); }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  const br = best.r / best.n, bgc = best.g / best.n, bb = best.b / best.n;

  // Texto: píxeles más alejados del fondo
  let max = 0;
  const dist = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const d = Math.abs(data[i] - br) + Math.abs(data[i + 1] - bgc) + Math.abs(data[i + 2] - bb);
    dist[j] = d;
    if (d > max) max = d;
  }
  let fg;
  if (max < 40) {
    fg = (br * 0.299 + bgc * 0.587 + bb * 0.114) > 128 ? '#000000' : '#ffffff';
  } else {
    let n = 0, r = 0, g = 0, b = 0;
    for (let j = 0; j < dist.length; j++) {
      if (dist[j] >= max * 0.9) { n++; r += data[j * 4]; g += data[j * 4 + 1]; b += data[j * 4 + 2]; }
    }
    r /= n; g /= n; b /= n;
    // El suavizado de bordes aclara el color medido: un gris casi negro se trata como negro
    if (Math.max(r, g, b) < 48 && Math.max(r, g, b) - Math.min(r, g, b) < 12) r = g = b = 0;
    fg = hex(r, g, b);
  }
  return { bg: hex(br, bgc, bb), fg };
}

// ---------- Búsqueda ----------
const norm = (s) => s.replace(/\u00a0/g, ' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export async function searchDocument(query, onProgress) {
  const q = norm(query.trim());
  const results = [];
  if (!q) return results;
  for (const p of state.pages) {
    const lines = await getLines(p);
    for (const l of lines) {
      // Una anotación de varias líneas se busca fila a fila (cada fila tiene su posición)
      const rows = l.rows || [{ text: l.text, w: l.w, y: l.top, h: l.bottom - l.top }];
      for (const r of rows) {
        const t = norm(r.text);
        let i = t.indexOf(q);
        while (i !== -1) {
          const n = r.text.length || 1;
          results.push({ uid: p.uid, x: (r.x ?? l.x) + (r.w * i) / n, y: r.y, w: (r.w * q.length) / n, h: r.h });
          i = t.indexOf(q, i + q.length);
        }
      }
    }
    onProgress?.(results.length);
  }
  return results;
}
