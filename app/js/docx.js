// Word (.docx) → PDF, en el propio dispositivo (nada se sube a ningún servidor).
// Lee el documento (párrafos, estilos, listas numeradas y con viñetas, tablas, imágenes, encabezados y pies de
// página con número de página, saltos de página y secciones) y lo compone con pdf-lib usando las fuentes estándar
// del PDF (Helvetica, Times y Courier en lugar de Calibri, Arial, Times New Roman...). No es una copia exacta de
// Word: las líneas pueden cortarse en otro sitio y no se convierten gráficos, notas al pie ni el ajuste del texto
// alrededor de las imágenes.
import { toPdfText } from './pdftext.js';
import { t } from './i18n.js';

const { PDFDocument, StandardFonts: SF, rgb } = PDFLib;
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// ---------- .docx = zip ----------
async function inflate(data) {
  const s = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let e = bytes.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(t('Solo se pueden convertir documentos .docx (Word 2007 o posterior). Si es un .doc antiguo, guárdalo antes como .docx.'));
  }
  const n = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const files = new Map();
  const dec = new TextDecoder();
  for (let i = 0; i < n && dv.getUint32(p, true) === 0x02014b50; i++) {
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const loc = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nl));
    const start = loc + 30 + dv.getUint16(loc + 26, true) + dv.getUint16(loc + 28, true);
    files.set(name.toLowerCase(), { method, data: bytes.subarray(start, start + size) });
    p += 46 + nl + xl + cl;
  }
  const get = async (name) => {
    const f = files.get(name.replace(/^\//, '').toLowerCase());
    if (!f) return null;
    return f.method === 8 ? inflate(f.data) : f.data;
  };
  return { bytes: get, text: async (name) => { const b = await get(name); return b && new TextDecoder().decode(b); } };
}

// ---------- XML ----------
const parseXml = (t) => (t ? new DOMParser().parseFromString(t, 'application/xml') : null);
const kids = (el, name) => (el ? [...el.children].filter((c) => !name || c.localName === name) : []);
const kid = (el, name) => (el ? [...el.children].find((c) => c.localName === name) || null : null);
const at = (el, name) => (el ? el.getAttributeNS(W_NS, name) ?? el.getAttribute('w:' + name) : null);
const isOn = (el) => !!el && !/^(0|false|off|none)$/i.test(at(el, 'val') || '');
const tw = (v) => (+v || 0) / 20; // veinteavos de punto → puntos
const emu = (v) => (+v || 0) / 12700; // EMU → puntos
const firstDeep = (el, name) => (el ? el.getElementsByTagNameNS('*', name)[0] || null : null);

const HIGHLIGHT = {
  yellow: 'FFFF00', green: '00FF00', cyan: '00FFFF', magenta: 'FF00FF', blue: '0000FF', red: 'FF0000',
  darkBlue: '000080', darkCyan: '008080', darkGreen: '008000', darkMagenta: '800080', darkRed: '800000',
  darkYellow: '808000', darkGray: '808080', lightGray: 'C0C0C0', black: '000000', white: 'FFFFFF',
};
function color(hex, fallback = rgb(0, 0, 0)) {
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return fallback;
  const n = parseInt(hex, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Fuentes de Word → fuentes estándar del PDF
function family(name = '') {
  const n = name.toLowerCase();
  if (/courier|consolas|mono|lucida console|cousine/.test(n)) return 'C';
  if (!/sans/.test(n) && /times|georgia|cambria|garamond|antiqua|palatino|serif|tinos|constantia|bookman|baskerville|minion|schoolbook/.test(n)) return 'T';
  return 'H';
}
const FONT_NAMES = {
  H: [SF.Helvetica, SF.HelveticaBold, SF.HelveticaOblique, SF.HelveticaBoldOblique],
  T: [SF.TimesRoman, SF.TimesRomanBold, SF.TimesRomanItalic, SF.TimesRomanBoldItalic],
  C: [SF.Courier, SF.CourierBold, SF.CourierOblique, SF.CourierBoldOblique],
};
// Altura de línea "sencilla" de Word según la fuente original (en múltiplos del tamaño)
function lineFactor(name = '') {
  const n = name.toLowerCase();
  if (/calibri|carlito|aptos/.test(n)) return 1.22;
  if (/segoe/.test(n)) return 1.33;
  if (/cambria/.test(n)) return 1.17;
  return 1.15;
}

function fmtNum(n, fmt) {
  const roman = (x) => {
    let s = '';
    for (const [v, r] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]) {
      while (x >= v) { s += r; x -= v; }
    }
    return s;
  };
  const letters = (x) => { let s = ''; while (x > 0) { x--; s = String.fromCharCode(97 + (x % 26)) + s; x = Math.floor(x / 26); } return s; };
  switch (fmt) {
    case 'lowerLetter': return letters(n);
    case 'upperLetter': return letters(n).toUpperCase();
    case 'lowerRoman': return roman(n);
    case 'upperRoman': return roman(n).toUpperCase();
    case 'decimalZero': return (n < 10 ? '0' : '') + n;
    case 'ordinal': return n + 'º';
    case 'none': return '';
    default: return String(n);
  }
}

/**
 * Convierte un .docx (bytes) en un PDF (bytes). onProgress(i, n) informa del avance.
 */
export async function docxToPdf(bytes, onProgress) {
  const zipf = unzip(bytes);
  const pdf = await PDFDocument.create();

  // --- Partes del paquete ---
  async function readRels(path) {
    const dir = path.slice(0, path.lastIndexOf('/') + 1);
    const relPath = dir + '_rels/' + path.slice(dir.length) + '.rels';
    const map = new Map(), types = new Map();
    const x = parseXml(await zipf.text(relPath));
    for (const r of x ? [...x.documentElement.children] : []) {
      if (r.getAttribute('TargetMode') === 'External') continue;
      let t = r.getAttribute('Target') || '';
      if (t.startsWith('/')) t = t.slice(1);
      else {
        const parts = (dir + t).split('/');
        const out = [];
        for (const s of parts) { if (s === '..') out.pop(); else if (s !== '.') out.push(s); }
        t = out.join('/');
      }
      map.set(r.getAttribute('Id'), t);
      types.set(r.getAttribute('Type')?.split('/').pop(), t);
    }
    return { map, types };
  }
  const rootRels = await readRels('');
  const mainPath = rootRels.types.get('officeDocument') || 'word/document.xml';
  const main = { path: mainPath, ...(await readRels(mainPath)) };
  const docXml = parseXml(await zipf.text(mainPath));
  if (!docXml || docXml.querySelector('parsererror')) throw new Error(t('No se pudo leer el documento de Word.'));
  const body = kid(docXml.documentElement, 'body');
  const partXml = async (target) => parseXml(await zipf.text(target));

  // --- Tema (fuentes "del tema", p. ej. Calibri / Aptos) ---
  const theme = { major: 'Calibri Light', minor: 'Calibri' };
  const themeXml = main.types.get('theme') && await partXml(main.types.get('theme'));
  if (themeXml) {
    for (const k of ['major', 'minor']) {
      const f = firstDeep(themeXml.getElementsByTagNameNS('*', k + 'Font')[0], 'latin')?.getAttribute('typeface');
      if (f) theme[k] = f;
    }
  }

  // --- Ajustes ---
  let defTab = 36;
  const settings = main.types.get('settings') && await partXml(main.types.get('settings'));
  if (settings) defTab = tw(at(kid(settings.documentElement, 'defaultTabStop'), 'val')) || 36;

  // --- Propiedades de texto y de párrafo ---
  function readRPr(el, base) {
    const r = { ...base };
    if (!el) return r;
    for (const c of el.children) {
      switch (c.localName) {
        case 'rFonts': {
          const th = at(c, 'asciiTheme') || at(c, 'hAnsiTheme');
          const f = at(c, 'ascii') || at(c, 'hAnsi') || (th ? theme[th.startsWith('major') ? 'major' : 'minor'] : null);
          if (f) r.font = f;
          break;
        }
        case 'sz': if (+at(c, 'val')) r.size = +at(c, 'val') / 2; break;
        case 'b': r.b = isOn(c); break;
        case 'i': r.i = isOn(c); break;
        case 'u': r.u = (at(c, 'val') || 'single') !== 'none'; break;
        case 'strike': case 'dstrike': r.strike = isOn(c); break;
        case 'color': { const v = at(c, 'val'); r.color = v && v !== 'auto' ? v : null; break; }
        case 'highlight': r.bg = HIGHLIGHT[at(c, 'val')] || null; break;
        case 'shd': { const f = at(c, 'fill'); if (f && f !== 'auto') r.bg = f; break; }
        case 'vertAlign': r.vert = at(c, 'val'); break;
        case 'caps': case 'smallCaps': r.caps = isOn(c); break;
        case 'vanish': r.hidden = isOn(c); break;
        default:
      }
    }
    return r;
  }

  function readBorder(el) {
    if (!el) return undefined;
    const v = at(el, 'val');
    if (!v || v === 'none' || v === 'nil') return null;
    const c = at(el, 'color');
    return { w: Math.max(0.25, (+at(el, 'sz') || 4) / 8), color: c && c !== 'auto' ? c : '000000' };
  }

  function readPPr(el, base) {
    const p = { ...base };
    if (!el) return p;
    for (const c of el.children) {
      switch (c.localName) {
        case 'jc': p.jc = at(c, 'val'); break;
        case 'ind': {
          const l = at(c, 'left') ?? at(c, 'start'); if (l != null) p.indL = tw(l);
          const r = at(c, 'right') ?? at(c, 'end'); if (r != null) p.indR = tw(r);
          const h = at(c, 'hanging'), f = at(c, 'firstLine');
          if (h != null) p.first = -tw(h); else if (f != null) p.first = tw(f);
          break;
        }
        case 'spacing': {
          const b = at(c, 'before'), a = at(c, 'after'), l = at(c, 'line');
          if (b != null) p.before = tw(b);
          if (a != null) p.after = tw(a);
          if (/^(1|true|on)$/.test(at(c, 'beforeAutospacing') || '')) p.before = 14;
          if (/^(1|true|on)$/.test(at(c, 'afterAutospacing') || '')) p.after = 14;
          if (l != null) { p.line = +l; p.lineRule = at(c, 'lineRule') || 'auto'; }
          break;
        }
        case 'numPr': {
          const id = at(kid(c, 'numId'), 'val'), lv = at(kid(c, 'ilvl'), 'val');
          if (id != null) p.numId = id;
          if (lv != null) p.ilvl = +lv;
          break;
        }
        case 'shd': { const f = at(c, 'fill'); p.shd = f && f !== 'auto' ? f : null; break; }
        case 'pBdr': p.bdrTop = readBorder(kid(c, 'top')) ?? p.bdrTop; p.bdrBottom = readBorder(kid(c, 'bottom')) ?? p.bdrBottom; break;
        case 'tabs': {
          let tabs = [...(p.tabs || [])];
          for (const t of kids(c, 'tab')) {
            const pos = tw(at(t, 'pos')), val = at(t, 'val');
            tabs = tabs.filter((x) => Math.abs(x.pos - pos) > 0.5);
            if (val !== 'clear') tabs.push({ pos, val, leader: at(t, 'leader') });
          }
          p.tabs = tabs.sort((a, b) => a.pos - b.pos);
          break;
        }
        case 'pageBreakBefore': p.pageBreakBefore = isOn(c); break;
        case 'contextualSpacing': p.contextual = isOn(c); break;
        default:
      }
    }
    return p;
  }

  // --- Estilos ---
  const stylesXml = main.types.get('styles') && await partXml(main.types.get('styles'));
  const styleEls = new Map();
  let defR = { font: 'Times New Roman', size: 10 };
  let defP = { before: 0, after: 0, line: 240, lineRule: 'auto', indL: 0, indR: 0, first: 0, jc: 'left' };
  let defaultPStyle = null, defaultTStyle = null;
  if (stylesXml) {
    const root = stylesXml.documentElement;
    const dd = kid(root, 'docDefaults');
    defR = readRPr(kid(kid(dd, 'rPrDefault'), 'rPr'), defR);
    defP = readPPr(kid(kid(dd, 'pPrDefault'), 'pPr'), defP);
    for (const s of kids(root, 'style')) {
      const id = at(s, 'styleId');
      styleEls.set(id, s);
      if (/^(1|true)$/.test(at(s, 'default') || '')) {
        if (at(s, 'type') === 'paragraph') defaultPStyle = id;
        if (at(s, 'type') === 'table') defaultTStyle = id;
      }
    }
  }
  const styleCache = new Map();
  function style(id) {
    if (!id) return null;
    if (styleCache.has(id)) return styleCache.get(id);
    styleCache.set(id, null); // evita ciclos
    const el = styleEls.get(id);
    let out = null;
    if (el) {
      const base = style(at(kid(el, 'basedOn'), 'val'));
      out = { el, p: readPPr(kid(el, 'pPr'), base?.p || {}), r: readRPr(kid(el, 'rPr'), base?.r || {}), base };
    }
    styleCache.set(id, out);
    return out;
  }

  // --- Numeración (listas) ---
  const numXml = main.types.get('numbering') && await partXml(main.types.get('numbering'));
  const absNums = new Map(), nums = new Map();
  if (numXml) {
    for (const a of kids(numXml.documentElement, 'abstractNum')) {
      const lv = new Map();
      for (const l of kids(a, 'lvl')) lv.set(+at(l, 'ilvl'), l);
      absNums.set(at(a, 'abstractNumId'), lv);
    }
    for (const n of kids(numXml.documentElement, 'num')) {
      const over = new Map();
      for (const o of kids(n, 'lvlOverride')) {
        over.set(+at(o, 'ilvl'), { start: at(kid(o, 'startOverride'), 'val'), lvl: kid(o, 'lvl') });
      }
      nums.set(at(n, 'numId'), { abs: at(kid(n, 'abstractNumId'), 'val'), over });
    }
  }
  const lvlCache = new Map();
  function lvl(numId, ilvl) {
    const key = numId + ':' + ilvl;
    if (lvlCache.has(key)) return lvlCache.get(key);
    const n = nums.get(numId);
    const o = n?.over.get(ilvl);
    const el = o?.lvl || absNums.get(n?.abs)?.get(ilvl);
    let out = null;
    if (el) {
      out = {
        start: +(o?.start ?? at(kid(el, 'start'), 'val') ?? 1),
        fmt: at(kid(el, 'numFmt'), 'val') || 'decimal',
        text: at(kid(el, 'lvlText'), 'val') ?? '',
        suff: at(kid(el, 'suff'), 'val') || 'tab',
        p: readPPr(kid(el, 'pPr'), {}),
        rEl: kid(el, 'rPr'),
      };
    }
    lvlCache.set(key, out);
    return out;
  }
  const counters = new Map();
  function numberLabel(numId, ilvl, markR) {
    const L = lvl(numId, ilvl);
    if (!L) return null;
    const c = counters.get(numId) || [];
    for (let k = ilvl + 1; k < 10; k++) c[k] = undefined;
    c[ilvl] = c[ilvl] == null ? L.start : c[ilvl] + 1;
    counters.set(numId, c);
    const r = readRPr(L.rEl, { ...markR, u: false, bg: null });
    let text;
    if (L.fmt === 'bullet') {
      text = /symbol|wingdings|webdings/i.test(r.font || '') && L.text !== 'o' ? '•' : L.text.replace(/[-]/g, '•');
      r.font = /courier/i.test(r.font || '') ? r.font : 'Arial';
    } else {
      text = L.text.replace(/%(\d)/g, (_, d) => {
        const k = +d - 1;
        const Lk = lvl(numId, k);
        return fmtNum(c[k] ?? Lk?.start ?? 1, Lk?.fmt);
      });
    }
    return { text, r, suff: L.suff };
  }

  // --- Fuentes y medidas ---
  const fonts = {};
  async function fontFor(r) {
    const fam = family(r.font);
    const i = (r.b ? 1 : 0) + (r.i ? 2 : 0);
    return (fonts[fam + i] ||= await pdf.embedFont(FONT_NAMES[fam][i]));
  }
  const widths = new Map();
  function textWidth(s, font, size) {
    let m = widths.get(font);
    if (!m) widths.set(font, (m = new Map()));
    let w = 0;
    for (const ch of s) {
      let cw = m.get(ch);
      if (cw === undefined) { try { cw = font.widthOfTextAtSize(ch, 1); } catch { cw = 0.5; } m.set(ch, cw); }
      w += cw;
    }
    return w * size;
  }

  // --- Imágenes ---
  const imgCache = new Map();
  async function image(part, rid) {
    const target = part.map.get(rid);
    if (!target) return null;
    if (imgCache.has(target)) return imgCache.get(target);
    let img = null;
    try {
      const b = await zipf.bytes(target);
      if (b[0] === 0x89 && b[1] === 0x50) img = await pdf.embedPng(b);
      else if (b[0] === 0xff && b[1] === 0xd8) img = await pdf.embedJpg(b);
      else {
        // GIF, BMP, WebP, TIFF...: se pasan a PNG con el navegador (EMF/WMF no se pueden)
        const bmp = await createImageBitmap(new Blob([b]));
        const cv = document.createElement('canvas');
        cv.width = bmp.width; cv.height = bmp.height;
        cv.getContext('2d').drawImage(bmp, 0, 0);
        const png = await new Promise((res) => cv.toBlob(res, 'image/png'));
        img = await pdf.embedPng(new Uint8Array(await png.arrayBuffer()));
      }
    } catch (err) {
      console.warn('Imagen no convertida', target, err);
    }
    imgCache.set(target, img);
    return img;
  }

  // ---------- Párrafos ----------
  // Resultado de componer: una lista de "cajas" de altura h que se colocan una debajo de otra.
  //  { h, draw(rec, x, y) }  línea o bloque; rec = página destino, (x, y) = esquina superior izquierda
  //  { h, top: true }       espacio antes del párrafo (no se pone al principio de una página)
  //  { h }                  espacio
  //  { brk: 'page' | 'ifNotTop' }   salto de página
  //  { table }              tabla (se puede partir entre páginas)
  function paraProps(pEl, layer) {
    const pPr = kid(pEl, 'pPr');
    const sid = at(kid(pPr, 'pStyle'), 'val') || defaultPStyle;
    const st = style(sid);
    const lay = layer || { p: {}, r: {} };
    // En las tablas, el estilo de la tabla manda sobre el estilo de párrafo predeterminado (como en Word)
    const stack = (L) => (sid === defaultPStyle ? [L, st?.p || {}, lay.p] : [L, lay.p, st?.p || {}]);
    const stackR = sid === defaultPStyle ? [st?.r || {}, lay.r] : [lay.r, st?.r || {}];
    let p = readPPr(pPr, Object.assign({}, defP, ...stack({})));
    if (p.numId && p.numId !== '0') {
      const L = lvl(p.numId, p.ilvl || 0);
      if (L) p = readPPr(pPr, Object.assign({}, defP, ...stack(L.p)));
    }
    p.styleId = sid;
    const r = Object.assign({}, defR, ...stackR);
    p.markR = readRPr(kid(pPr, 'rPr'), r);
    return { p, r, pPr };
  }

  function fieldKind(instr) {
    const m = /^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/i.exec(instr || '');
    return m ? (m[1].toUpperCase() === 'PAGE' ? 'page' : 'total') : null;
  }

  function flattenRuns(el, out) {
    for (const c of el.children) {
      switch (c.localName) {
        case 'r': out.push(c); break;
        case 'fldSimple': {
          const k = fieldKind(at(c, 'instr'));
          if (k) out.push({ field: k, rEl: firstDeep(c, 'r') });
          else flattenRuns(c, out);
          break;
        }
        case 'hyperlink': case 'ins': case 'smartTag': case 'customXml': case 'dir': case 'bdo': case 'moveTo':
          flattenRuns(c, out); break;
        case 'sdt': flattenRuns(kid(c, 'sdtContent') || c, out); break;
        case 'oMath': case 'oMathPara':
          out.push({ math: [...c.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join('') }); break;
        default:
      }
    }
    return out;
  }

  async function layoutParagraph(pEl, part, width, layer, seq) {
    const { p, r: baseR } = paraProps(pEl, layer);
    const boxes = [];
    const after = []; // contenido de cuadros de texto, se pone detrás del párrafo
    const atoms = [];
    let word = null;
    const closeWord = () => { if (word) { atoms.push(word); word = null; } };

    async function mkPart(s, rp, field) {
      const font = await fontFor(rp);
      const small = rp.vert === 'superscript' || rp.vert === 'subscript';
      const size = (rp.size || 10) * (small ? 0.65 : 1);
      const dy = rp.vert === 'superscript' ? -(rp.size || 10) * 0.33 : rp.vert === 'subscript' ? (rp.size || 10) * 0.14 : 0;
      return { s, r: rp, font, size, dy, field, w: textWidth(field ? '99' : s, font, size) };
    }
    async function addText(s, rp) {
      if (rp.hidden || !s) return;
      if (rp.caps) s = s.toUpperCase();
      s = toPdfText(s);
      for (const seg of s.split(/( +)/)) {
        if (!seg) continue;
        const part = await mkPart(seg, rp);
        if (seg[0] === ' ') { closeWord(); atoms.push({ k: 'sp', parts: [part], w: part.w }); }
        else { (word ||= { k: 'w', parts: [], w: 0 }).parts.push(part); word.w += part.w; }
      }
    }
    const maxImgW = Math.max(20, width - p.indL - p.indR);
    function fitImage(w, h) {
      const k = Math.min(1, maxImgW / w, 680 / h);
      return [w * k, h * k];
    }

    async function addDrawing(holder, rp) {
      if (!holder) return;
      const anchor = holder.localName === 'anchor';
      let w = emu(kid(holder, 'extent')?.getAttribute('cx')), h = emu(kid(holder, 'extent')?.getAttribute('cy'));
      const blip = firstDeep(holder, 'blip');
      const rid = blip && (blip.getAttributeNS(R_NS, 'embed') || blip.getAttribute('r:embed'));
      const txbx = firstDeep(holder, 'txbxContent');
      const floating = anchor && kid(holder, 'wrapNone');
      if (rid && w > 0 && h > 0) {
        const img = await image(part, rid);
        if (!img) return;
        if (floating) {
          const behind = holder.getAttribute('behindDoc') === '1';
          boxes.push({ h: 0, draw: (rec, x, y) => { const [ax, ay] = anchorPos(holder, rec.sec, x, y, w, h); (behind ? rec.bg : rec.ops).push((pg) => pg.drawImage(img, { x: ax, y: rec.h - ay - h, width: w, height: h })); } });
          return;
        }
        [w, h] = fitImage(w, h);
        closeWord();
        atoms.push({ k: 'img', img, w, h, r: rp });
        return;
      }
      if (txbx) {
        const inner = await layoutBlocks(kids(txbx), part, floating ? Math.max(20, w - 14) : width, null, true);
        if (floating) {
          boxes.push({ h: 0, draw: (rec, x, y) => { const [ax, ay] = anchorPos(holder, rec.sec, x, y, w, h); let yy = ay + 4; for (const b of inner) { b.draw?.(rec, ax + 7, yy); yy += b.h || 0; } } });
        } else after.push(...inner);
      }
    }

    // --- Recorrer el texto ---
    let fld = null; // campo complejo en curso: { instr, sep, kind, depth }
    for (const item of flattenRuns(pEl, [])) {
      if (item.math != null) { await addText(item.math, baseR); continue; }
      if (item.field) {
        const rp = readRPr(kid(item.rEl, 'rPr'), baseR);
        const part = await mkPart('', rp, item.field);
        (word ||= { k: 'w', parts: [], w: 0 }).parts.push(part); word.w += part.w;
        continue;
      }
      const rPr = kid(item, 'rPr');
      const rs = style(at(kid(rPr, 'rStyle'), 'val'));
      const rp = readRPr(rPr, { ...baseR, ...(rs?.r || {}) });
      for (const c of item.children) {
        const n = c.localName;
        if (n === 'fldChar') {
          const t = at(c, 'fldCharType');
          if (t === 'begin') { if (fld) fld.depth++; else fld = { instr: '', sep: false, depth: 0 }; }
          else if (fld && t === 'separate' && !fld.depth) {
            fld.sep = true;
            fld.kind = fieldKind(fld.instr);
            if (fld.kind) { const part = await mkPart('', rp, fld.kind); (word ||= { k: 'w', parts: [], w: 0 }).parts.push(part); word.w += part.w; }
          } else if (fld && t === 'end') {
            if (fld.depth) fld.depth--;
            else {
              if (!fld.sep && fieldKind(fld.instr)) { const part = await mkPart('', rp, fieldKind(fld.instr)); (word ||= { k: 'w', parts: [], w: 0 }).parts.push(part); word.w += part.w; }
              fld = null;
            }
          }
          continue;
        }
        if (n === 'instrText') { if (fld && !fld.depth && !fld.sep) fld.instr += c.textContent; continue; }
        if (fld && (!fld.sep || fld.kind)) continue; // código del campo o resultado ya sustituido
        switch (n) {
          case 't': await addText(c.textContent, rp); break;
          case 'tab': case 'ptab': closeWord(); atoms.push({ k: 'tab', r: rp }); break;
          case 'br': case 'cr':
            closeWord();
            atoms.push({ k: at(c, 'type') === 'page' ? 'page' : 'br' });
            break;
          case 'noBreakHyphen': await addText('-', rp); break;
          case 'sym': await addText('•', rp); break;
          case 'drawing': await addDrawing(kid(c, 'inline') || kid(c, 'anchor'), rp); break;
          case 'AlternateContent': {
            const ch = kid(c, 'Choice') || kid(c, 'Fallback');
            const d = firstDeep(ch, 'drawing');
            if (d) await addDrawing(kid(d, 'inline') || kid(d, 'anchor'), rp);
            break;
          }
          case 'pict': case 'object': {
            const im = firstDeep(c, 'imagedata');
            const rid = im && (im.getAttributeNS(R_NS, 'id') || im.getAttribute('r:id'));
            const shape = im?.parentElement;
            const st = shape?.getAttribute('style') || '';
            const num = (k) => { const m = new RegExp(k + ':\\s*([\\d.]+)(pt|in|px)?').exec(st); return m ? +m[1] * (m[2] === 'in' ? 72 : m[2] === 'px' ? 0.75 : 1) : 0; };
            if (rid) {
              const img = await image(part, rid);
              if (img) { const [w, h] = fitImage(num('width') || img.width * 0.75, num('height') || img.height * 0.75); closeWord(); atoms.push({ k: 'img', img, w, h, r: rp }); }
            }
            const tb = firstDeep(c, 'txbxContent');
            if (tb) after.push(...(await layoutBlocks(kids(tb), part, width, null, true)));
            break;
          }
          default:
        }
      }
    }
    closeWord();

    // --- Cortar en líneas ---
    const label = p.numId && p.numId !== '0' ? numberLabel(p.numId, p.ilvl || 0, p.markR) : null;
    const lines = [];
    let line;
    const start = (first) => {
      const x0 = first ? p.indL + p.first : p.indL;
      line = { items: [], first, x0, x: 0, avail: width - p.indR - x0 };
    };
    const hasContent = () => line.items.some((it) => !it.space);
    const finish = (how) => { line.end = how; lines.push(line); };
    function nextStop(ax) {
      for (const t of p.tabs || []) if (t.pos > ax + 0.5 && t.val !== 'bar') return t;
      if (p.first < 0 && ax < p.indL - 0.5) return { pos: p.indL, val: 'left' };
      return { pos: (Math.floor(ax / defTab + 1e-6) + 1) * defTab, val: 'left' };
    }
    start(true);
    if (label) {
      const lp = await mkPart(toPdfText(label.text), label.r);
      line.items.push({ x: 0, w: lp.w, parts: [lp] });
      line.x = lp.w;
      if (label.suff === 'space') line.x += textWidth(' ', lp.font, lp.size);
      else if (label.suff !== 'nothing') line.x = nextStop(line.x0 + line.x).pos - line.x0;
    }
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      if (a.k === 'br' || a.k === 'page') {
        finish(a.k);
        if (a.k === 'page') lines.push({ pageBreak: true });
        start(false);
        continue;
      }
      if (a.k === 'tab') {
        const st = nextStop(line.x0 + line.x);
        if (st.pos > width + 1) { finish('wrap'); start(false); continue; }
        let nx = st.pos - line.x0;
        if (/^(right|end|center|decimal)$/.test(st.val)) {
          let seg = 0;
          for (let j = i + 1; j < atoms.length && !/^(tab|br|page)$/.test(atoms[j].k); j++) seg += atoms[j].w;
          nx -= st.val === 'center' ? seg / 2 : seg;
        }
        nx = Math.max(nx, line.x);
        line.items.push({ x: line.x, w: nx - line.x, tab: true, leader: st.leader, r: a.r });
        line.x = nx;
        line.hasTab = true;
        continue;
      }
      if (a.k === 'sp') {
        if (!line.first && !line.items.length) continue; // espacios al principio de una línea partida
        line.items.push({ x: line.x, w: a.w, parts: a.parts, space: true });
        line.x += a.w;
        continue;
      }
      // palabra o imagen
      if (line.x + a.w > line.avail + 0.01 && hasContent()) { finish('wrap'); start(false); }
      if (a.k === 'w' && a.w > line.avail - line.x + 0.01) {
        // palabra más larga que la línea: se parte por letras
        for (const part of a.parts) {
          let rest = part.s;
          while (rest) {
            let n = rest.length;
            while (n > 1 && line.x + textWidth(rest.slice(0, n), part.font, part.size) > line.avail) n--;
            const piece = { ...part, s: rest.slice(0, n), w: textWidth(rest.slice(0, n), part.font, part.size) };
            line.items.push({ x: line.x, w: piece.w, parts: [piece] });
            line.x += piece.w;
            rest = rest.slice(n);
            if (rest) { finish('wrap'); start(false); }
          }
        }
        continue;
      }
      line.items.push(a.k === 'img' ? { x: line.x, w: a.w, img: a.img, h: a.h } : { x: line.x, w: a.w, parts: a.parts });
      line.x += a.w;
    }
    if (line.items.length || !lines.length || lines[lines.length - 1].end === 'br') finish('end');

    // --- Medidas de cada línea ---
    for (const ln of lines) {
      if (ln.pageBreak) continue;
      let asc = 0, desc = 0;
      for (const it of ln.items) {
        if (it.img) { asc = Math.max(asc, it.h); continue; }
        for (const pt of it.parts || []) {
          const nat = (pt.r.size || 10) * lineFactor(pt.r.font);
          asc = Math.max(asc, nat * 0.78);
          desc = Math.max(desc, nat * 0.22);
        }
      }
      if (!asc) {
        const nat = (p.markR.size || 10) * lineFactor(p.markR.font);
        asc = nat * 0.78; desc = nat * 0.22;
      }
      const nat = asc + desc;
      let h = nat;
      if (p.lineRule === 'exact') h = tw(p.line);
      else if (p.lineRule === 'atLeast') h = Math.max(nat, tw(p.line));
      else h = nat * ((p.line || 240) / 240);
      ln.h = h;
      ln.base = h - desc;
      let last = ln.items.length - 1;
      while (last >= 0 && ln.items[last].space) last--;
      ln.contentW = last >= 0 ? ln.items[last].x + ln.items[last].w : 0;
    }

    // --- Cajas ---
    const realLines = lines.filter((l) => !l.pageBreak);
    if (p.pageBreakBefore) boxes.unshift({ brk: 'ifNotTop' });
    const beforeBox = { h: p.before || 0, top: true };
    const afterBox = { h: p.after || 0, after: true };
    if (seq?.prev && seq.prev.styleId === p.styleId) {
      if (p.contextual) beforeBox.h = 0;
      if (seq.prev.contextual) seq.prev.afterBox.h = 0;
    }
    if (p.bdrTop) beforeBox.h += p.bdrTop.w + 2;
    boxes.push(beforeBox);
    const xL = p.indL, xR = width - p.indR;
    for (const ln of lines) {
      if (ln.pageBreak) { boxes.push({ brk: 'page' }); continue; }
      const isLast = ln === realLines[realLines.length - 1];
      const slack = ln.avail - ln.contentW;
      let off = 0, perSpace = 0;
      const jc = p.jc || 'left';
      if (jc === 'center') off = slack / 2;
      else if (jc === 'right' || jc === 'end') off = slack;
      else if ((jc === 'both' || jc === 'distribute') && ln.end === 'wrap' && !ln.hasTab && slack > 0) {
        let n = 0;
        let lastContent = ln.items.length - 1;
        while (lastContent >= 0 && ln.items[lastContent].space) lastContent--;
        for (let k = 0; k < lastContent; k++) if (ln.items[k].space) n++;
        if (n) perSpace = slack / n;
      }
      const topBorder = ln === realLines[0] && p.bdrTop;
      const bottomBorder = isLast && p.bdrBottom;
      boxes.push({
        h: ln.h,
        draw(rec, X, Y) {
          if (p.shd) rec.bg.push((pg) => pg.drawRectangle({ x: X + xL, y: rec.h - Y - ln.h, width: xR - xL, height: ln.h, color: color(p.shd) }));
          if (topBorder) rec.ops.push((pg) => pg.drawLine({ start: { x: X + xL, y: rec.h - Y + topBorder.w + 1 }, end: { x: X + xR, y: rec.h - Y + topBorder.w + 1 }, thickness: topBorder.w, color: color(topBorder.color) }));
          if (bottomBorder) rec.ops.push((pg) => pg.drawLine({ start: { x: X + xL, y: rec.h - Y - ln.h - 2 }, end: { x: X + xR, y: rec.h - Y - ln.h - 2 }, thickness: bottomBorder.w, color: color(bottomBorder.color) }));
          rec.ops.push((pg, ctx) => {
            let shift = 0;
            const baseY = rec.h - Y - ln.base;
            for (const it of ln.items) {
              const x = X + ln.x0 + off + it.x + shift;
              if (it.space && perSpace) shift += perSpace;
              if (it.img) { pg.drawImage(it.img, { x, y: baseY, width: it.w, height: it.h }); continue; }
              if (it.tab) {
                if (it.leader && it.leader !== 'none' && it.w > 6) {
                  const ch = it.leader === 'hyphen' ? '-' : it.leader === 'underscore' ? '_' : it.leader === 'middleDot' ? '·' : '.';
                  const size = it.r?.size || 10;
                  const f = fonts.H0;
                  const cw = textWidth(ch, f, size);
                  const n = Math.floor((it.w - 4) / cw);
                  if (n > 0) pg.drawText(ch.repeat(n), { x: x + it.w - n * cw - 2, y: baseY, size, font: f, color: color(it.r?.color) });
                }
                continue;
              }
              let px = x;
              for (const pt of it.parts) {
                const s = pt.field ? String(pt.field === 'page' ? ctx.num : ctx.total) : pt.s;
                const w = pt.field ? textWidth(s, pt.font, pt.size) : pt.w;
                const y = baseY - pt.dy;
                if (pt.r.bg) pg.drawRectangle({ x: px, y: y - pt.size * 0.25, width: w + (it.space ? perSpace : 0), height: pt.size * 1.15, color: color(pt.r.bg) });
                if (!it.space) pg.drawText(s, { x: px, y, size: pt.size, font: pt.font, color: color(pt.r.color) });
                const lw = Math.max(0.5, pt.size * 0.06);
                if (pt.r.u) pg.drawLine({ start: { x: px, y: y - pt.size * 0.13 }, end: { x: px + w + (it.space ? perSpace : 0), y: y - pt.size * 0.13 }, thickness: lw, color: color(pt.r.color) });
                if (pt.r.strike) pg.drawLine({ start: { x: px, y: y + pt.size * 0.3 }, end: { x: px + w, y: y + pt.size * 0.3 }, thickness: lw, color: color(pt.r.color) });
                px += w;
                if (pt.field) shift += w - pt.w; // el número real ocupa distinto que el reservado
              }
            }
          });
        },
      });
    }
    if (p.bdrBottom) afterBox.h += p.bdrBottom.w + 3;
    boxes.push(afterBox);
    boxes.push(...after);
    if (seq) seq.prev = { styleId: p.styleId, contextual: p.contextual, afterBox };
    return boxes;
  }

  function anchorPos(holder, sec, X, Y, w, h) {
    const ph = kid(holder, 'positionH'), pv = kid(holder, 'positionV');
    const hrel = ph?.getAttribute('relativeFrom') || 'column', vrel = pv?.getAttribute('relativeFrom') || 'paragraph';
    const halign = kid(ph, 'align')?.textContent, valign = kid(pv, 'align')?.textContent;
    const hoff = emu(kid(ph, 'posOffset')?.textContent), voff = emu(kid(pv, 'posOffset')?.textContent);
    let fx = sec.left, fw = sec.contentW;
    if (hrel === 'page') { fx = 0; fw = sec.w; }
    else if (hrel === 'leftMargin' || hrel === 'insideMargin') { fx = 0; fw = sec.left; }
    else if (hrel === 'rightMargin' || hrel === 'outsideMargin') { fx = sec.left + sec.contentW; fw = sec.w - fx; }
    else if (hrel === 'character') { fx = X; }
    let fy = Y, fh = sec.bottomY - sec.marginTop;
    if (vrel === 'page') { fy = 0; fh = sec.h; }
    else if (vrel === 'margin') { fy = sec.marginTop; }
    else if (vrel === 'topMargin') { fy = 0; fh = sec.marginTop; }
    else if (vrel === 'bottomMargin') { fy = sec.bottomY; fh = sec.h - sec.bottomY; }
    const x = halign ? fx + (halign === 'center' ? (fw - w) / 2 : halign === 'right' || halign === 'outside' ? fw - w : 0) : fx + hoff;
    const y = valign ? fy + (valign === 'center' ? (fh - h) / 2 : valign === 'bottom' || valign === 'outside' ? fh - h : 0) : fy + voff;
    return [x, y];
  }

  // ---------- Tablas ----------
  function readMar(el, m) {
    if (!el) return;
    for (const [k, names] of [['l', ['left', 'start']], ['r', ['right', 'end']], ['t', ['top']], ['b', ['bottom']]]) {
      for (const n of names) { const e = kid(el, n); if (e) m[k] = tw(at(e, 'w')); }
    }
  }
  function readBorders(el, b) {
    if (!el) return;
    for (const k of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV', 'start', 'end']) {
      const v = readBorder(kid(el, k));
      if (v !== undefined) b[k === 'start' ? 'left' : k === 'end' ? 'right' : k] = v;
    }
  }

  async function layoutTable(tEl, part, width) {
    const tblPr = kid(tEl, 'tblPr');
    const ts = style(at(kid(tblPr, 'tblStyle'), 'val')) || style(defaultTStyle);
    const chain = [];
    for (let s = ts; s; s = s.base) chain.unshift(s.el);
    const borders = {}, mar = { l: 5.4, r: 5.4, t: 0, b: 0 };
    for (const el of chain) { readBorders(kid(kid(el, 'tblPr'), 'tblBorders'), borders); readMar(kid(kid(el, 'tblPr'), 'tblCellMar'), mar); }
    readBorders(kid(tblPr, 'tblBorders'), borders);
    readMar(kid(tblPr, 'tblCellMar'), mar);
    const look = kid(tblPr, 'tblLook');
    const lookVal = parseInt(at(look, 'val') || '0', 16) || 0;
    const firstRow = at(look, 'firstRow') === '1' || !!(lookVal & 0x20);
    const hBand = !(at(look, 'noHBand') === '1' || lookVal & 0x200);
    const cond = (type) => {
      let out = null;
      for (const el of chain) {
        const c = kids(el, 'tblStylePr').find((x) => at(x, 'type') === type);
        if (!c) continue;
        out ||= { p: {}, r: {}, fill: null };
        out.p = readPPr(kid(c, 'pPr'), out.p);
        out.r = readRPr(kid(c, 'rPr'), out.r);
        const f = at(kid(kid(c, 'tcPr'), 'shd'), 'fill');
        if (f && f !== 'auto') out.fill = f;
      }
      return out;
    };
    const condFirst = firstRow ? cond('firstRow') : null;
    const condBand = hBand ? cond('band1Horz') : null;
    const baseLayer = { p: ts?.p || {}, r: ts?.r || {} };

    const trs = [];
    (function collect(el) { for (const c of el.children) { if (c.localName === 'tr') trs.push(c); else if (/^(sdt|sdtContent|customXml)$/.test(c.localName)) collect(c); } })(tEl);
    let grid = kids(kid(tEl, 'tblGrid'), 'gridCol').map((g) => tw(at(g, 'w')));
    const nCols = Math.max(grid.length, ...trs.map((tr) => kids(tr, 'tc').reduce((n, tc) => n + (+at(kid(kid(tc, 'tcPr'), 'gridSpan'), 'val') || 1), 0)));
    if (!grid.length || grid.some((g) => !g) || grid.length < nCols) grid = Array(nCols).fill(width / Math.max(1, nCols));
    let total = grid.reduce((a, b) => a + b, 0);
    const tblW = kid(tblPr, 'tblW');
    if (at(tblW, 'type') === 'pct') {
      const v = at(tblW, 'w') || '';
      const target = width * (v.endsWith('%') ? parseFloat(v) / 100 : (+v || 5000) / 5000);
      grid = grid.map((g) => (g * target) / total);
      total = target;
    }
    if (total > width + 2) { grid = grid.map((g) => (g * width) / total); total = width; }
    const xs = [0];
    for (const g of grid) xs.push(xs[xs.length - 1] + g);
    let offset = tw(at(kid(tblPr, 'tblInd'), 'w'));
    const jc = at(kid(tblPr, 'jc'), 'val');
    if (jc === 'center') offset = (width - total) / 2;
    else if (jc === 'right' || jc === 'end') offset = width - total;

    const rows = [];
    let band = 0;
    for (const [ri, tr] of trs.entries()) {
      const trPr = kid(tr, 'trPr');
      const isHeader = isOn(kid(trPr, 'tblHeader'));
      const cnd = ri === 0 && condFirst ? condFirst : condBand && (band++ % 2 === 0) ? condBand : null;
      if (ri === 0 && condFirst) band = 0;
      const layer = cnd ? { p: { ...baseLayer.p, ...cnd.p }, r: { ...baseLayer.r, ...cnd.r } } : baseLayer;
      let col = +at(kid(trPr, 'gridBefore'), 'val') || 0;
      const cells = [];
      for (const tc of kids(tr, 'tc')) {
        const tcPr = kid(tc, 'tcPr');
        const span = +at(kid(tcPr, 'gridSpan'), 'val') || 1;
        const c0 = Math.min(col, grid.length - 1), c1 = Math.min(col + span, grid.length);
        const x = xs[c0], w = Math.max(10, xs[c1] - xs[c0]);
        col += span;
        const vm = kid(tcPr, 'vMerge');
        const vMerge = vm ? (at(vm, 'val') === 'restart' ? 'restart' : 'cont') : null;
        const m = { ...mar };
        readMar(kid(tcPr, 'tcMar'), m);
        const b = {};
        readBorders(kid(tcPr, 'tcBorders'), b);
        const f = at(kid(tcPr, 'shd'), 'fill');
        const fill = f && f !== 'auto' ? f : cnd?.fill || null;
        const boxes = vMerge === 'cont' ? [] : await layoutBlocks(kids(tc), part, Math.max(8, w - m.l - m.r), layer, true);
        const contentH = boxes.reduce((s, bx) => s + (bx.h || 0), 0);
        cells.push({ x, w, col: c0, vMerge, mar: m, b, fill, boxes, contentH, vAlign: at(kid(tcPr, 'vAlign'), 'val') });
      }
      const trH = kid(trPr, 'trHeight');
      rows.push({ cells, header: isHeader, hVal: tw(at(trH, 'val')), hRule: at(trH, 'hRule') || 'atLeast' });
    }
    // Celdas combinadas en vertical: cuántas filas ocupan
    for (const [ri, row] of rows.entries()) {
      for (const c of row.cells) {
        if (c.vMerge !== 'restart') continue;
        let k = 1;
        while (ri + k < rows.length && rows[ri + k].cells.some((d) => d.col === c.col && d.vMerge === 'cont')) k++;
        c.span = k;
        if (k > 1) {
          for (let j = 1; j < k; j++) {
            const d = rows[ri + j].cells.find((x) => x.col === c.col && x.vMerge === 'cont');
            d.fill ||= c.fill;
            d.contBottom = j < k - 1;
          }
          c.contBottom = true;
        }
      }
    }
    for (const row of rows) {
      let h = 0;
      for (const c of row.cells) if (c.vMerge !== 'cont' && !(c.span > 1)) h = Math.max(h, c.contentH + c.mar.t + c.mar.b);
      if (row.hRule === 'exact' && row.hVal) h = row.hVal;
      else h = Math.max(h, row.hVal || 0, 4);
      row.h = h;
    }
    for (const [ri, row] of rows.entries()) {
      for (const c of row.cells) {
        if (!(c.span > 1)) continue;
        const need = c.contentH + c.mar.t + c.mar.b;
        let have = 0;
        for (let j = 0; j < c.span; j++) have += rows[ri + j].h;
        if (need > have) rows[ri + c.span - 1].h += need - have;
      }
    }
    return { rows, offset, borders, total };
  }

  // Dibuja una fila (o un trozo de fila) de la tabla. parts[i] = cajas de la celda i que van en este trozo.
  function drawRow(rec, tbl, row, ri, X, Y, h, parts, cutTop, cutBottom) {
    const B = tbl.borders;
    const lastRow = ri === tbl.rows.length - 1;
    row.cells.forEach((c, ci) => {
      const cx = X + tbl.offset + c.x;
      if (c.fill) rec.bg.push((pg) => pg.drawRectangle({ x: cx, y: rec.h - Y - h, width: c.w, height: h, color: color(c.fill) }));
      const bx = parts[ci];
      if (bx?.length) {
        const ch = bx.reduce((s, b) => s + (b.h || 0), 0);
        let y = Y + c.mar.t;
        if (!(c.span > 1) && !cutTop && !cutBottom) {
          const free = h - c.mar.t - c.mar.b - ch;
          if (c.vAlign === 'center') y += free / 2;
          else if (c.vAlign === 'bottom') y += free;
        }
        for (const b of bx) { b.draw?.(rec, cx + c.mar.l, y); y += b.h || 0; }
      }
      const pick = (own, def) => (own !== undefined ? own : def);
      const edges = [
        ['top', c.vMerge === 'cont' && !cutTop ? null : pick(c.b.top, ri === 0 || cutTop ? B.top : B.insideH)],
        ['bottom', (c.contBottom && !cutBottom) ? null : pick(c.b.bottom, lastRow || cutBottom ? B.bottom ?? B.insideH : B.insideH)],
        ['left', pick(c.b.left, ci === 0 ? B.left : B.insideV)],
        ['right', pick(c.b.right, ci === row.cells.length - 1 ? B.right : B.insideV)],
      ];
      for (const [side, e] of edges) {
        if (!e) continue;
        const x1 = side === 'right' ? cx + c.w : cx, x2 = side === 'left' ? cx : cx + c.w;
        const y1 = side === 'bottom' ? Y + h : Y, y2 = side === 'top' ? Y : Y + h;
        rec.ops.push((pg) => pg.drawLine({ start: { x: x1, y: rec.h - y1 }, end: { x: x2, y: rec.h - y2 }, thickness: e.w, color: color(e.color) }));
      }
    });
  }

  // Tabla dentro de una celda o un cuadro de texto: un bloque que no se parte
  function tableBlock(tbl) {
    const h = tbl.rows.reduce((s, r) => s + r.h, 0);
    return {
      h,
      draw(rec, X, Y) {
        let y = Y;
        tbl.rows.forEach((row, ri) => { drawRow(rec, tbl, row, ri, X, y, row.h, row.cells.map((c) => c.boxes)); y += row.h; });
      },
    };
  }

  async function layoutBlocks(children, part, width, layer, nested, seq = { prev: null }) {
    const out = [];
    for (const c of children) {
      if (c.localName === 'p') out.push(...(await layoutParagraph(c, part, width, layer, seq)));
      else if (c.localName === 'tbl') {
        const t = await layoutTable(c, part, width);
        out.push(nested ? tableBlock(t) : { table: t });
        seq.prev = null;
      } else if (/^(sdt|customXml)$/.test(c.localName)) {
        out.push(...(await layoutBlocks(kids(kid(c, 'sdtContent') || c), part, width, layer, nested, seq)));
      }
    }
    if (nested) return out.filter((b) => !b.brk);
    return out;
  }

  // ---------- Secciones, encabezados y pies ----------
  const sectEls = [];
  for (const c of body.children) {
    if (c.localName === 'p') { const s = kid(kid(c, 'pPr'), 'sectPr'); if (s) sectEls.push(s); }
  }
  const finalSect = kid(body, 'sectPr');
  if (finalSect) sectEls.push(finalSect);
  if (!sectEls.length) sectEls.push(null);
  const hfCache = new Map();
  async function headerBoxes(rid, width) {
    const target = rid && main.map.get(rid);
    if (!target) return null;
    const key = target + '@' + width;
    if (!hfCache.has(key)) {
      const x = await partXml(target);
      const part = { path: target, ...(await readRels(target)) };
      const boxes = x ? await layoutBlocks(kids(x.documentElement), part, width, null, true) : [];
      hfCache.set(key, { boxes, h: boxes.reduce((s, b) => s + (b.h || 0), 0) });
    }
    return hfCache.get(key);
  }
  const sections = [];
  let prevRefs = { header: {}, footer: {} };
  for (const el of sectEls) {
    const sz = kid(el, 'pgSz'), m = kid(el, 'pgMar');
    const w = tw(at(sz, 'w')) || 612, h = tw(at(sz, 'h')) || 792;
    const g = (k, d) => Math.abs(tw(at(m, k) ?? d));
    const s = {
      w, h, marginTop: g('top', 1440), left: g('left', 1440), right: g('right', 1440), marginBottom: g('bottom', 1440),
      headerDist: g('header', 720), footerDist: g('footer', 720), titlePg: isOn(kid(el, 'titlePg')), type: at(kid(el, 'type'), 'val'),
    };
    s.contentW = Math.max(50, w - s.left - s.right);
    const refs = { header: { ...prevRefs.header }, footer: { ...prevRefs.footer } };
    for (const k of ['header', 'footer']) {
      for (const r of kids(el, k + 'Reference')) refs[k][at(r, 'type') || 'default'] = r.getAttributeNS(R_NS, 'id') || r.getAttribute('r:id');
    }
    prevRefs = refs;
    s.hdr = { default: await headerBoxes(refs.header.default, s.contentW), first: await headerBoxes(refs.header.first, s.contentW) };
    s.ftr = { default: await headerBoxes(refs.footer.default, s.contentW), first: await headerBoxes(refs.footer.first, s.contentW) };
    const hh = Math.max(s.hdr.default?.h || 0, s.titlePg ? s.hdr.first?.h || 0 : 0);
    const fh = Math.max(s.ftr.default?.h || 0, s.titlePg ? s.ftr.first?.h || 0 : 0);
    s.top = Math.max(s.marginTop, s.headerDist + hh);
    s.bottomY = h - Math.max(s.marginBottom, s.footerDist + fh);
    sections.push(s);
  }

  // ---------- Colocar en páginas ----------
  const recs = [];
  let sec = sections[0], rec, y;
  const newPage = (firstOfSection = false) => {
    rec = { w: sec.w, h: sec.h, sec, ops: [], bg: [], firstOfSection };
    recs.push(rec);
    y = sec.top;
  };
  const atTop = () => y <= sec.top + 0.5;

  function placeTable(tbl) {
    const headerRows = [];
    for (const r of tbl.rows) { if (r.header) headerRows.push(r); else break; }
    const repeatHeader = () => {
      headerRows.forEach((r, i) => { drawRow(rec, tbl, r, i, sec.left, y, r.h, r.cells.map((c) => c.boxes)); y += r.h; });
    };
    tbl.rows.forEach((row, ri) => {
      if (y + row.h > sec.bottomY + 0.5 && !atTop()) { newPage(); if (!row.header) repeatHeader(); }
      if (y + row.h <= sec.bottomY + 0.5) {
        drawRow(rec, tbl, row, ri, sec.left, y, row.h, row.cells.map((c) => c.boxes));
        y += row.h;
        return;
      }
      // Fila más alta que una página: se parte
      let rest = row.cells.map((c) => [...c.boxes]);
      let cutTop = false;
      for (let guard = 0; guard < 200; guard++) {
        const avail = sec.bottomY - y;
        const take = rest.map((bx, ci) => {
          const c = row.cells[ci];
          const out = [];
          let used = c.mar.t + c.mar.b;
          while (bx.length && (used + (bx[0].h || 0) <= avail || !out.length && atTop())) { used += bx[0].h || 0; out.push(bx.shift()); }
          return out;
        });
        const done = rest.every((bx) => !bx.length);
        const h = done ? Math.max(4, ...row.cells.map((c, ci) => take[ci].reduce((s, b) => s + (b.h || 0), 0) + c.mar.t + c.mar.b)) : avail;
        drawRow(rec, tbl, row, ri, sec.left, y, h, take, cutTop, !done);
        y += h;
        if (done) break;
        newPage();
        repeatHeader();
        cutTop = true;
      }
    });
  }

  // El espacio "después" de un párrafo se aplica al colocar lo siguiente (puede anularlo el espaciado contextual,
  // y al final de una página no se pone)
  let pending = null;
  function place(boxes) {
    for (const b of boxes) {
      if (b.after) { pending = b; continue; }
      const extra = pending ? pending.h : 0;
      pending = null;
      if (b.brk) { if (b.brk === 'page' || !atTop()) newPage(); continue; }
      if (b.table) { if (!atTop()) y += extra; placeTable(b.table); continue; }
      if (!b.draw) { if (!(b.top && atTop())) y += extra + b.h; continue; }
      if (b.h > 0 && y + extra + b.h > sec.bottomY + 0.5 && !atTop()) newPage();
      else if (!atTop()) y += extra;
      b.draw(rec, sec.left, y);
      y += b.h;
    }
  }

  await fontFor({ font: 'Arial' }); // para los puntos de los tabuladores
  newPage(true);
  const blocks = [...body.children];
  let si = 0;
  const seq = { prev: null };
  for (let i = 0; i < blocks.length; i++) {
    const c = blocks[i];
    if (i % 10 === 0) onProgress?.(i, blocks.length);
    if (c.localName === 'sectPr') continue;
    place(await layoutBlocks([c], main, sec.contentW, null, false, seq));
    if (c.localName === 'p' && kid(kid(c, 'pPr'), 'sectPr') && si < sections.length - 1) {
      si++;
      sec = sections[si];
      if (sec.type !== 'continuous') newPage(true);
    }
  }

  // Encabezados y pies de página
  for (const r of recs) {
    const s = r.sec;
    const first = s.titlePg && r.firstOfSection;
    const hd = first ? s.hdr.first : s.hdr.default;
    const ft = first ? s.ftr.first : s.ftr.default;
    if (hd) { let yy = s.headerDist; for (const b of hd.boxes) { b.draw?.(r, s.left, yy); yy += b.h || 0; } }
    if (ft) { let yy = s.h - s.footerDist - ft.h; for (const b of ft.boxes) { b.draw?.(r, s.left, yy); yy += b.h || 0; } }
  }

  // Generar el PDF
  const total = recs.length;
  recs.forEach((r, i) => {
    const pg = pdf.addPage([r.w, r.h]);
    const ctx = { num: i + 1, total };
    for (const f of r.bg) f(pg, ctx);
    for (const f of r.ops) f(pg, ctx);
  });
  onProgress?.(blocks.length, blocks.length);
  return pdf.save();
}
