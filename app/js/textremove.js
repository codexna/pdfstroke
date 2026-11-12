// Elimina del flujo de contenido de una página (y de los formularios XObject que dibuja) los glifos del texto
// original que quedan bajo las zonas editadas (texto original reemplazado y rectángulos de "Tapar"). Así el texto
// antiguo no reaparece al copiar, buscar o extraer. Ante cualquier construcción no soportada se deja el contenido
// tal cual (el texto sigue tapado visualmente), nunca se arriesga a estropear la página.
const {
  PDFName, PDFDict, PDFArray, PDFNumber, PDFRef, PDFNull, PDFStream, PDFRawStream, decodePDFRawStream, StandardFontEmbedder,
} = PDFLib;

// ---------- Analizador léxico de flujos de contenido ----------
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const latin1 = (b, s, e) => { let r = ''; for (let i = s; i < e; i++) r += String.fromCharCode(b[i]); return r; };

class Lexer {
  constructor(bytes) { this.b = bytes; this.i = 0; }

  skipWs() {
    const b = this.b;
    while (this.i < b.length) {
      const c = b[this.i];
      if (WS.has(c)) this.i++;
      else if (c === 37) { while (this.i < b.length && b[this.i] !== 10 && b[this.i] !== 13) this.i++; }
      else break;
    }
  }

  next() {
    this.skipWs();
    const b = this.b, s = this.i;
    if (s >= b.length) return null;
    const c = b[s];
    if (c === 40) return { t: 'str', v: this.literal(), s, e: this.i };
    if (c === 60) {
      if (b[s + 1] === 60) { this.i += 2; return { t: 'dict', v: this.dict(), s, e: this.i }; }
      return { t: 'str', v: this.hex(), s, e: this.i };
    }
    if (c === 91) {
      this.i++;
      const v = [];
      for (;;) {
        this.skipWs();
        if (this.i >= b.length) throw new Error('Array sin cerrar');
        if (b[this.i] === 93) { this.i++; break; }
        const tk = this.next();
        if (!tk || tk.t === 'op') throw new Error('Array mal formado');
        v.push(tk);
      }
      return { t: 'arr', v, s, e: this.i };
    }
    if (c === 47) {
      this.i++;
      while (this.i < b.length && !WS.has(b[this.i]) && !DELIM.has(b[this.i])) this.i++;
      return { t: 'name', v: latin1(b, s + 1, this.i), s, e: this.i };
    }
    if (DELIM.has(c)) throw new Error('Delimitador inesperado');
    while (this.i < b.length && !WS.has(b[this.i]) && !DELIM.has(b[this.i])) this.i++;
    const word = latin1(b, s, this.i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: parseFloat(word), s, e: this.i };
    if (word === 'true' || word === 'false' || word === 'null') return { t: 'kw', v: word, s, e: this.i };
    return { t: 'op', v: word, s, e: this.i };
  }

  literal() {
    const b = this.b, out = [];
    let depth = 0;
    this.i++;
    while (this.i < b.length) {
      const c = b[this.i++];
      if (c === 92) {
        const n = b[this.i++];
        switch (n) {
          case 110: out.push(10); break;
          case 114: out.push(13); break;
          case 116: out.push(9); break;
          case 98: out.push(8); break;
          case 102: out.push(12); break;
          case 13: if (b[this.i] === 10) this.i++; break;
          case 10: break;
          default:
            if (n >= 48 && n <= 55) {
              let v = n - 48;
              for (let k = 0; k < 2 && b[this.i] >= 48 && b[this.i] <= 55; k++) v = v * 8 + (b[this.i++] - 48);
              out.push(v & 255);
            } else out.push(n);
        }
      } else if (c === 40) { depth++; out.push(c); }
      else if (c === 41) { if (depth === 0) return Uint8Array.from(out); depth--; out.push(c); }
      else out.push(c);
    }
    throw new Error('Cadena sin cerrar');
  }

  hex() {
    const b = this.b;
    let digits = '';
    this.i++;
    while (this.i < b.length && b[this.i] !== 62) { const c = b[this.i++]; if (!WS.has(c)) digits += String.fromCharCode(c); }
    if (this.i >= b.length) throw new Error('Cadena hexadecimal sin cerrar');
    this.i++;
    if (digits.length % 2) digits += '0';
    const out = new Uint8Array(digits.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = parseInt(digits.substr(k * 2, 2), 16) || 0;
    return out;
  }

  dict() {
    const b = this.b, v = [];
    for (;;) {
      this.skipWs();
      if (this.i >= b.length) throw new Error('Diccionario sin cerrar');
      if (b[this.i] === 62 && b[this.i + 1] === 62) { this.i += 2; return v; }
      const tk = this.next();
      if (!tk || tk.t === 'op') throw new Error('Diccionario mal formado');
      v.push(tk);
    }
  }

  /** Salta los datos binarios de una imagen en línea (desde "ID" hasta "EI"). */
  skipInlineImage() {
    const b = this.b;
    for (let k = this.i + 1; k < b.length - 1; k++) {
      if (b[k] === 69 && b[k + 1] === 73 && WS.has(b[k - 1]) && (k + 2 >= b.length || WS.has(b[k + 2]))) {
        this.i = k + 2;
        return;
      }
    }
    throw new Error('Imagen en línea sin final');
  }
}

function parseOps(bytes) {
  const lx = new Lexer(bytes);
  const ops = [];
  let operands = [], start = -1;
  for (;;) {
    const tk = lx.next();
    if (!tk) break;
    if (start < 0) start = tk.s;
    if (tk.t !== 'op') { operands.push(tk); continue; }
    if (tk.v === 'BI') {
      for (;;) {
        const t2 = lx.next();
        if (!t2) throw new Error('Imagen en línea sin datos');
        if (t2.t === 'op' && t2.v === 'ID') break;
      }
      lx.skipInlineImage();
      ops.push({ op: 'BI', operands: [], s: start, e: lx.i });
    } else {
      ops.push({ op: tk.v, operands, s: start, e: tk.e });
    }
    operands = [];
    start = -1;
  }
  return ops;
}

// ---------- Métricas de fuentes ----------
const nameOf = (o) => (o instanceof PDFName ? o.asString().slice(1) : null);
const numOf = (o) => (o instanceof PDFNumber ? o.asNumber() : undefined);

function standardFontName(base) {
  const b = base.replace(/^[A-Z]{6}\+/, '');
  let fam = null;
  if (/^(Helvetica|Arial)/i.test(b)) fam = 'Helvetica';
  else if (/^Times/i.test(b)) fam = 'Times';
  else if (/^Courier/i.test(b)) fam = 'Courier';
  else if (/^Symbol$/i.test(b)) return 'Symbol';
  else if (/^ZapfDingbats$/i.test(b)) return 'ZapfDingbats';
  if (!fam) return null;
  const bold = /bold/i.test(b), italic = /italic|oblique/i.test(b);
  if (fam === 'Times') return 'Times-' + (bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Roman');
  const suffix = bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : '';
  return fam + suffix;
}

/** Devuelve { bytes, width(code) } (anchura en unidades de texto por punto de cuerpo) o null si no se puede medir. */
function fontMetrics(dict) {
  const sub = nameOf(dict.lookup(PDFName.of('Subtype')));
  if (sub === 'Type0') {
    if (nameOf(dict.lookup(PDFName.of('Encoding'))) !== 'Identity-H') return null;
    const desc = dict.lookup(PDFName.of('DescendantFonts'));
    const cid = desc instanceof PDFArray ? desc.lookup(0) : null;
    if (!(cid instanceof PDFDict)) return null;
    const dw = numOf(cid.lookup(PDFName.of('DW'))) ?? 1000;
    const widths = new Map();
    const W = cid.lookup(PDFName.of('W'));
    if (W instanceof PDFArray) {
      for (let k = 0; k < W.size();) {
        const first = numOf(W.lookup(k));
        const next = W.lookup(k + 1);
        if (first === undefined) return null;
        if (next instanceof PDFArray) {
          for (let j = 0; j < next.size(); j++) widths.set(first + j, numOf(next.lookup(j)) ?? dw);
          k += 2;
        } else {
          const last = numOf(next), w = numOf(W.lookup(k + 2));
          if (last === undefined || w === undefined) return null;
          for (let c = first; c <= last; c++) widths.set(c, w);
          k += 3;
        }
      }
    }
    return { bytes: 2, width: (code) => (widths.get(code) ?? dw) / 1000 };
  }

  const first = numOf(dict.lookup(PDFName.of('FirstChar'))) ?? 0;
  const Widths = dict.lookup(PDFName.of('Widths'));
  if (Widths instanceof PDFArray) {
    let scale = 1 / 1000;
    if (sub === 'Type3') {
      const fm = dict.lookup(PDFName.of('FontMatrix'));
      scale = fm instanceof PDFArray ? numOf(fm.lookup(0)) ?? 0.001 : 0.001;
    }
    const fd = dict.lookup(PDFName.of('FontDescriptor'));
    const missing = (fd instanceof PDFDict && numOf(fd.lookup(PDFName.of('MissingWidth')))) || 0;
    const ws = Widths.asArray().map((w) => numOf(dict.context.lookup(w)) ?? 0);
    return { bytes: 1, width: (code) => (code - first >= 0 && code - first < ws.length ? ws[code - first] : missing) * scale };
  }

  // Fuentes estándar sin tabla de anchuras: se usan las métricas incluidas en pdf-lib
  if (sub !== 'Type1' && sub !== 'TrueType') return null;
  const std = standardFontName(nameOf(dict.lookup(PDFName.of('BaseFont'))) || '');
  if (!std) return null;
  const emb = StandardFontEmbedder.for(std);
  const names = new Map();
  for (const [code, glyph] of Object.values(emb.encoding.unicodeMappings)) if (!names.has(code)) names.set(code, glyph);
  const enc = dict.lookup(PDFName.of('Encoding'));
  const diff = enc instanceof PDFDict ? enc.lookup(PDFName.of('Differences')) : null;
  if (diff instanceof PDFArray) {
    let code = 0;
    for (let k = 0; k < diff.size(); k++) {
      const it = diff.lookup(k);
      if (it instanceof PDFNumber) code = it.asNumber();
      else if (it instanceof PDFName) names.set(code++, it.asString().slice(1));
    }
  }
  return {
    bytes: 1,
    width: (code) => {
      const g = names.get(code);
      const w = g ? emb.font.getWidthOfGlyph(g) : undefined;
      return typeof w === 'number' ? w / 1000 : undefined;
    },
  };
}

// ---------- Geometría ----------
const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const zonesAt = (zones, x, y) => zones.filter((z) => !z.img && x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1);
const fmtNum = (v) => (Math.abs(v) < 1e-6 ? '0' : (+v.toFixed(4)).toString());
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function readStream(stream) {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (typeof stream?.getUnencodedContents === 'function') return stream.getUnencodedContents();
  throw new Error('Flujo de contenido no soportado');
}

/**
 * Quita de la página los glifos cuyo centro cae dentro de alguna zona, también los que están dentro de formularios
 * XObject que la página dibuja (de éstos se hace una copia modificada sólo para esta página: el original puede usarse
 * en otras).
 * @param zones rectángulos en espacio de usuario PDF: { x0, y0, x1, y1 }; al terminar, cada zona lleva en `visible` e
 *   `invisible` cuántos glifos visibles e invisibles se le han quitado, y `imageAfter` si después se dibujó encima
 *   una imagen (entonces lo que se veía era la imagen, no ese texto)
 * @returns número de glifos eliminados
 */
export function removeTextInZones(doc, page, zones) {
  if (!zones.length) return 0;
  const node = page.node;
  const contents = node.Contents();
  if (!contents) return 0;
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  const parts = streams.map(readStream);
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; bytes[off++] = 10; }

  const job = { doc, zones, removed: 0, visiting: new Set() };
  const gs = { ctm: [1, 0, 0, 1, 0, 0], font: null, size: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0, Tr: 0, alpha: 1 };
  const resources = node.Resources();
  const { out, forms, dropped } = rewrite(job, bytes, resources, gs, 0);
  if (!out) return 0;
  if (forms.length || dropped.length) node.set(PDFName.of('Resources'), withForms(doc, resources, forms, dropped));
  // Como lista de flujos (igual que la deja pdf-lib al dibujar en la página): así se le pueden añadir otros después
  node.set(PDFName.of('Contents'), doc.context.obj([doc.context.register(doc.context.flateStream(out))]));
  return job.removed;
}

const MAX_DEPTH = 3; // formularios dentro de formularios
const SKIP_KEYS = new Set(['Length', 'Filter', 'DecodeParms', 'DL']);

/**
 * Copia de unos recursos (sin tocar los originales, que pueden ser de otras páginas) con los formularios modificados
 * añadidos y sin los que ya no se usan: así su texto quitado no queda escondido dentro del archivo.
 */
function withForms(doc, resources, forms, dropped = []) {
  const res = resources instanceof PDFDict ? resources.clone(doc.context) : doc.context.obj({});
  const xo = res.lookup(PDFName.of('XObject'));
  const xobjs = xo instanceof PDFDict ? xo.clone(doc.context) : doc.context.obj({});
  for (const n of dropped) xobjs.delete(PDFName.of(n));
  for (const f of forms) xobjs.set(PDFName.of(f.name), f.ref);
  res.set(PDFName.of('XObject'), xobjs);
  return res;
}

/**
 * Recorre un flujo de contenido quitando los glifos de las zonas. Devuelve el flujo nuevo (o null si no cambia) y
 * los formularios modificados que hay que añadir a sus recursos con su nombre nuevo.
 */
function rewrite(job, bytes, resources, gs0, depth) {
  const { doc, zones } = job;
  const ops = parseOps(bytes);
  const fontDicts = resources instanceof PDFDict ? resources.lookup(PDFName.of('Font')) : null;
  const xobjects = resources instanceof PDFDict ? resources.lookup(PDFName.of('XObject')) : null;
  const metricsCache = new Map();
  const getMetrics = (name) => {
    if (!metricsCache.has(name)) {
      let m = null;
      try {
        const d = fontDicts instanceof PDFDict ? fontDicts.lookup(PDFName.of(name)) : null;
        if (d instanceof PDFDict) m = fontMetrics(d);
      } catch { m = null; }
      metricsCache.set(name, m);
    }
    return metricsCache.get(name);
  };

  let gs = { ...gs0, ctm: [...gs0.ctm] };
  const stack = [];
  let Tm = [1, 0, 0, 1, 0, 0], Tlm = [1, 0, 0, 1, 0, 0];
  // Si no se pudo medir una operación, la posición del texto es desconocida hasta el siguiente cambio de línea
  let posKnown = true;
  const replacements = [];
  const forms = [];
  const names = new Set(xobjects instanceof PDFDict ? xobjects.keys().map((k) => k.asString().slice(1)) : []);
  // Cuántas veces se dibuja cada XObject (también desde los formularios sin recursos propios, que usan éstos) y cuántas
  // se ha sustituido por su copia: el que ya no se dibuja se quita de los recursos
  const doCount = new Map(), replacedCount = new Map();
  const countDo = (name, n = 1) => doCount.set(name, (doCount.get(name) || 0) + n);
  const num = (op, i) => op.operands[i]?.v;
  const setLine = (m) => { Tlm = m; Tm = m; posKnown = true; };
  const nextLine = () => setLine(mul([1, 0, 0, 1, 0, -gs.TL], Tlm));

  /** Recorre los glifos de una operación de texto; devuelve el nuevo contenido del array TJ o null si no cambia. */
  const showText = (items) => {
    const m = gs.font && getMetrics(gs.font);
    const fs = gs.size;
    const out = [];
    let changed = false, ok = !!m && fs !== 0 && gs.Tr < 4 && posKnown;
    let buf = [];
    const flush = () => { if (buf.length) { out.push(Uint8Array.from(buf)); buf = []; } };
    const pushNum = (v) => { flush(); if (typeof out[out.length - 1] === 'number') out[out.length - 1] += v; else out.push(v); };
    for (const it of items) {
      if (it.t === 'num') {
        pushNum(it.v);
        Tm = mul([1, 0, 0, 1, (-it.v / 1000) * fs * gs.Th, 0], Tm);
        continue;
      }
      if (it.t !== 'str') { ok = false; continue; }
      const s = it.v;
      const step = m ? m.bytes : 1;
      for (let k = 0; k + step <= s.length; k += step) {
        const code = step === 2 ? (s[k] << 8) | s[k + 1] : s[k];
        const w0 = m ? m.width(code) : undefined;
        if (w0 === undefined || !ok) {
          ok = false;
          for (let j = 0; j < step; j++) buf.push(s[k + j]);
          continue;
        }
        const space = step === 1 && code === 32 ? gs.Tw : 0;
        const adv = (w0 * fs + gs.Tc + space) * gs.Th;
        const trm = mul(Tm, gs.ctm);
        const [cx, cy] = apply(trm, (w0 * fs * gs.Th) / 2, gs.Ts + 0.35 * fs);
        const hit = zonesAt(zones, cx, cy);
        if (hit.length) {
          changed = true;
          job.removed++;
          // Se cuenta en cada zona si lo quitado se veía: el texto invisible (modo 3, p. ej. la capa de OCR de un
          // escaneo) no es lo que se ve, así que quitarlo no borra nada de la pantalla
          for (const z of hit) {
            if (gs.Tr === 3) z.invisible = (z.invisible || 0) + 1; else z.visible = (z.visible || 0) + 1;
            if ((z.centers ||= []).length < 400) z.centers.push([cx, cy]);
          }
          pushNum((-(w0 * fs + gs.Tc + space) * 1000) / fs);
        } else {
          for (let j = 0; j < step; j++) buf.push(s[k + j]);
        }
        Tm = mul([1, 0, 0, 1, adv, 0], Tm);
      }
    }
    flush();
    if (!ok) posKnown = false;
    if (!ok || !changed) return null;
    return '[' + out.map((p) => (typeof p === 'number' ? fmtNum(p) : '<' + toHex(p) + '>')).join(' ') + '] TJ';
  };

  /**
   * Una imagen dibujada encima de texto que se ha quitado: lo que se veía allí era la imagen (p. ej. un escaneo con el
   * texto reconocido debajo), así que quitar el texto no borra nada de lo que se ve.
   */
  const imageDrawn = (dict) => {
    // Una imagen con transparencia (máscara o canal alfa, o dibujada semitransparente) deja ver lo de debajo
    if (gs.alpha < 1 || (dict && ['SMask', 'Mask', 'ImageMask'].some((k) => {
      const v = dict.lookup(PDFName.of(k));
      return v && !(v instanceof PDFName && v.asString() === '/None') && v.toString() !== 'false';
    }))) return;
    const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(gs.ctm, x, y));
    const x0 = Math.min(...pts.map((q) => q[0])), x1 = Math.max(...pts.map((q) => q[0]));
    const y0 = Math.min(...pts.map((q) => q[1])), y1 = Math.max(...pts.map((q) => q[1]));
    for (const z of zones) {
      const c = z.centers || [];
      // Tiene que tapar al menos la mitad de las letras que se han quitado de la zona
      if (c.length && c.filter(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1).length * 2 >= c.length) z.imageAfter = true;
    }
  };

  // Transparencia de lo que se dibuja (opción "gs"): sólo hace falta saber si es opaco
  const setGraphicsState = (op) => {
    const name = op.operands[0]?.t === 'name' ? op.operands[0].v : null;
    const states = resources instanceof PDFDict ? resources.lookup(PDFName.of('ExtGState')) : null;
    const g = name && states instanceof PDFDict ? states.lookup(PDFName.of(name)) : null;
    if (!(g instanceof PDFDict)) return;
    const ca = numOf(g.lookup(PDFName.of('ca')));
    const sm = g.lookup(PDFName.of('SMask'));
    if (ca !== undefined || sm) gs.alpha = (ca ?? 1) < 1 || (sm && !(sm instanceof PDFName && sm.asString() === '/None')) ? 0.5 : 1;
  };

  /** Formulario XObject dibujado con "Do": si tiene texto en las zonas, se dibuja en su lugar una copia sin él. */
  const drawForm = (op, name, form) => {
    if (depth >= MAX_DEPTH || job.visiting.has(form)) return;
    const mat = form.dict.lookup(PDFName.of('Matrix'));
    const m = mat instanceof PDFArray && mat.size() === 6 ? mat.asArray().map((v) => numOf(doc.context.lookup(v)) ?? 0) : [1, 0, 0, 1, 0, 0];
    const own = form.dict.lookup(PDFName.of('Resources'));
    const res = own instanceof PDFDict ? own : resources; // sin recursos propios usa los de quien lo dibuja
    job.visiting.add(form);
    let inner;
    try {
      inner = rewrite(job, readStream(form), res, { ...gs, ctm: mul(m, gs.ctm) }, depth + 1);
    } catch (err) {
      // Un formulario que no se entiende se deja como está (sólo él: el resto de la página sigue adelante). Si usa
      // estos recursos, ninguno de ellos se puede quitar
      console.warn('Formulario XObject no soportado', err);
      if (!(own instanceof PDFDict)) for (const n of names) countDo(n, Infinity);
      return;
    } finally {
      job.visiting.delete(form);
    }
    if (!inner.out) {
      // Se sigue dibujando tal cual: lo que dibuja con estos recursos sigue haciendo falta
      if (!(own instanceof PDFDict)) for (const [n, c] of inner.doCount) countDo(n, c);
      return;
    }
    const entries = {};
    for (const [k, v] of form.dict.entries()) {
      const key = k.asString().slice(1);
      if (!SKIP_KEYS.has(key)) entries[key] = v;
    }
    // La copia lleva sus propios recursos si los necesita (o si usaba los de quien la dibuja): así éstos pueden cambiar
    if (inner.forms.length || inner.dropped.length || !(own instanceof PDFDict)) {
      // Si usaba los de quien la dibuja, sólo se quedan los XObject que dibuja ella: así no sigue enlazado el
      // formulario original (con el texto quitado) ni nada más que no le haga falta
      const xo = res instanceof PDFDict ? res.lookup(PDFName.of('XObject')) : null;
      const unused = own instanceof PDFDict || !(xo instanceof PDFDict) ? []
        : xo.keys().map((k) => k.asString().slice(1)).filter((n) => !inner.doCount.has(n));
      entries.Resources = withForms(doc, res, inner.forms, [...inner.dropped, ...unused]);
    }
    const ref = doc.context.register(doc.context.flateStream(inner.out, entries));
    let n = 1;
    while (names.has('EdX' + n)) n++;
    const newName = 'EdX' + n;
    names.add(newName);
    forms.push({ name: newName, ref });
    replacedCount.set(name, (replacedCount.get(name) || 0) + 1);
    replacements.push({ s: op.s, e: op.e, text: `/${newName} Do` });
  };

  /** Zona de imagen (ver pdfimages.js) que coincide con la imagen que se va a dibujar con la matriz actual. */
  const imageZone = () => {
    const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(gs.ctm, x, y));
    const x0 = Math.min(...pts.map((q) => q[0])), x1 = Math.max(...pts.map((q) => q[0]));
    const y0 = Math.min(...pts.map((q) => q[1])), y1 = Math.max(...pts.map((q) => q[1]));
    const tol = Math.max(1.5, 0.02 * Math.max(x1 - x0, y1 - y0));
    return zones.find((z) => z.img && Math.abs(z.x0 - x0) < tol && Math.abs(z.x1 - x1) < tol && Math.abs(z.y0 - y0) < tol && Math.abs(z.y1 - y1) < tol);
  };

  const drawXObject = (op) => {
    const name = op.operands[0]?.t === 'name' ? op.operands[0].v : null;
    if (!name) return;
    countDo(name);
    const xo = xobjects instanceof PDFDict ? xobjects.lookup(PDFName.of(name)) : null;
    if (!(xo instanceof PDFStream)) return;
    const sub = xo.dict.lookup(PDFName.of('Subtype'));
    const kind = sub instanceof PDFName ? sub.asString() : '';
    if (kind === '/Image') {
      const z = imageZone();
      if (z) {
        // Imagen original movida o eliminada: deja de dibujarse aquí
        z.removedImg = (z.removedImg || 0) + 1;
        replacedCount.set(name, (replacedCount.get(name) || 0) + 1);
        replacements.push({ s: op.s, e: op.e, text: '' });
        return;
      }
    }
    if (kind === '/Image') imageDrawn(xo.dict);
    else if (kind === '/Form') drawForm(op, name, xo);
  };

  for (const op of ops) {
    switch (op.op) {
      case 'q': stack.push({ ...gs, ctm: [...gs.ctm] }); break;
      case 'Q': if (stack.length) gs = stack.pop(); break;
      case 'cm': if (op.operands.length === 6) gs.ctm = mul(op.operands.map((o) => o.v), gs.ctm); break;
      case 'BT': setLine([1, 0, 0, 1, 0, 0]); break;
      case 'Tf': gs.font = op.operands[0]?.v ?? null; gs.size = num(op, 1) ?? 0; break;
      case 'Tc': gs.Tc = num(op, 0) ?? 0; break;
      case 'Tw': gs.Tw = num(op, 0) ?? 0; break;
      case 'Tz': gs.Th = (num(op, 0) ?? 100) / 100; break;
      case 'TL': gs.TL = num(op, 0) ?? 0; break;
      case 'Ts': gs.Ts = num(op, 0) ?? 0; break;
      case 'Tr': gs.Tr = num(op, 0) ?? 0; break;
      case 'Td': setLine(mul([1, 0, 0, 1, num(op, 0) ?? 0, num(op, 1) ?? 0], Tlm)); break;
      case 'TD': gs.TL = -(num(op, 1) ?? 0); setLine(mul([1, 0, 0, 1, num(op, 0) ?? 0, num(op, 1) ?? 0], Tlm)); break;
      case 'Tm': if (op.operands.length === 6) setLine(op.operands.map((o) => o.v)); break;
      case 'T*': nextLine(); break;
      case 'Tj': {
        const r = op.operands[0] && showText([op.operands[0]]);
        if (r) replacements.push({ s: op.s, e: op.e, text: r });
        break;
      }
      case 'TJ': {
        const arr = op.operands[0];
        const r = arr?.t === 'arr' && showText(arr.v);
        if (r) replacements.push({ s: op.s, e: op.e, text: r });
        break;
      }
      case "'": {
        nextLine();
        const r = op.operands[0] && showText([op.operands[0]]);
        if (r) replacements.push({ s: op.s, e: op.e, text: 'T* ' + r });
        break;
      }
      case '"': {
        gs.Tw = num(op, 0) ?? gs.Tw;
        gs.Tc = num(op, 1) ?? gs.Tc;
        nextLine();
        const r = op.operands[2] && showText([op.operands[2]]);
        if (r) replacements.push({ s: op.s, e: op.e, text: `${fmtNum(gs.Tw)} Tw ${fmtNum(gs.Tc)} Tc T* ${r}` });
        break;
      }
      case 'Do': drawXObject(op); break;
      case 'BI': imageDrawn(null); break;
      case 'gs': setGraphicsState(op); break;
    }
  }
  if (!replacements.length) return { out: null, forms, dropped: [], doCount };
  const dropped = [...replacedCount].filter(([n, c]) => c === doCount.get(n)).map(([n]) => n);

  // Reconstruir el flujo copiando lo que no cambia
  const enc = new TextEncoder();
  const chunks = [];
  let pos = 0;
  for (const r of replacements) {
    chunks.push(bytes.subarray(pos, r.s), enc.encode(' ' + r.text + ' '));
    pos = r.e;
  }
  chunks.push(bytes.subarray(pos));
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const result = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { result.set(c, off); off += c.length; }
  return { out: result, forms, dropped, doCount };
}

/**
 * Punto de partida (en el espacio del propio flujo) de cada texto que dibuja un flujo de contenido, en orden. Sirve
 * para saber dónde empieza cada fila de una anotación de texto (pdf.js sólo da la primera).
 */
export function textOrigins(bytes) {
  const out = [];
  let ctm = [1, 0, 0, 1, 0, 0], Tm = [1, 0, 0, 1, 0, 0], Tlm = [1, 0, 0, 1, 0, 0], TL = 0;
  const stack = [];
  const setLine = (m) => { Tlm = m; Tm = m; };
  for (const op of parseOps(bytes)) {
    const n = (i) => (typeof op.operands[i]?.v === 'number' ? op.operands[i].v : 0);
    switch (op.op) {
      case 'q': stack.push(ctm); break;
      case 'Q': if (stack.length) ctm = stack.pop(); break;
      case 'cm': if (op.operands.length === 6) ctm = mul(op.operands.map((o) => o.v), ctm); break;
      case 'BT': setLine([1, 0, 0, 1, 0, 0]); break;
      case 'TL': TL = n(0); break;
      case 'Td': setLine(mul([1, 0, 0, 1, n(0), n(1)], Tlm)); break;
      case 'TD': TL = -n(1); setLine(mul([1, 0, 0, 1, n(0), n(1)], Tlm)); break;
      case 'Tm': if (op.operands.length === 6) setLine(op.operands.map((o) => o.v)); break;
      case 'T*': setLine(mul([1, 0, 0, 1, 0, -TL], Tlm)); break;
      case "'": case '"': setLine(mul([1, 0, 0, 1, 0, -TL], Tlm)); out.push(apply(mul(Tm, ctm), 0, 0)); break;
      case 'Tj': case 'TJ': out.push(apply(mul(Tm, ctm), 0, 0)); break;
    }
  }
  return out;
}

/**
 * Elimina los objetos que ya no son alcanzables desde el catálogo (páginas borradas, flujos sustituidos...),
 * para que su contenido no quede oculto dentro del archivo.
 */
export function collectGarbage(doc) {
  const ctx = doc.context;
  // Una página borrada (o una copia suelta que arrastró un campo de formulario) puede seguir enlazada desde los
  // marcadores, los destinos, la estructura de un PDF etiquetado o un campo: esos enlaces se cortan para que su
  // contenido no quede dentro del archivo
  const kept = new Set(doc.getPages().map((p) => p.ref.toString()));
  const dead = (v) => {
    if (!(v instanceof PDFRef) || kept.has(v.toString())) return false;
    const d = ctx.lookup(v);
    return d instanceof PDFDict && d.get(PDFName.of('Type'))?.toString() === '/Page';
  };
  const seen = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info];
  while (stack.length) {
    const o = stack.pop();
    if (!o) continue;
    if (o instanceof PDFRef) {
      const key = o.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push(ctx.lookup(o));
    } else if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) { if (dead(v)) o.delete(k); else stack.push(v); }
    } else if (o instanceof PDFArray) {
      const items = o.asArray();
      items.forEach((v, i) => { if (dead(v)) o.set(i, PDFNull); else stack.push(v); });
    } else if (o.dict instanceof PDFDict) {
      stack.push(o.dict);
    }
  }
  let n = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.toString())) { ctx.delete(ref); n++; }
  }
  return n;
}
