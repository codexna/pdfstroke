// Genera el PDF final con pdf-lib: orden/rotación de páginas y objetos dibujados como contenido vectorial.
import { t } from './i18n.js';
import { state, isNoopEdit } from './state.js';
import { textMetrics, arrowHead, ellipseK, clampScale, layoutTextLines, fontsReady, textBox, getBBox, rotOf, objPoint } from './objects.js';
import { getLines } from './textlayer.js';
import { removeTextInZones, collectGarbage } from './textremove.js';
import { toPdfText } from './pdftext.js';
import { viewToPdf, pdfZone, lineSpec, failedKeys, annotIndexes, removeAnnotsAt } from './preview.js';

const {
  PDFDocument, PDFPage, PDFName, PDFDict, PDFArray, PDFNumber, PDFStream, PDFRef, PDFHexString, PDFString,
  StandardFonts: SF, rgb, degrees, toRadians, BlendMode, LineCapStyle, LineJoinStyle,
  pushGraphicsState, popGraphicsState, setCharacterSqueeze, setLineJoin, setGraphicsState, beginText, endText,
  setFontAndSize, setFillingColor, showText, rotateAndSkewTextRadiansAndTranslate,
} = PDFLib;

const FONT_MAP = {
  sans: [SF.Helvetica, SF.HelveticaBold, SF.HelveticaOblique, SF.HelveticaBoldOblique],
  serif: [SF.TimesRoman, SF.TimesRomanBold, SF.TimesRomanItalic, SF.TimesRomanBoldItalic],
  mono: [SF.Courier, SF.CourierBold, SF.CourierOblique, SF.CourierBoldOblique],
};

const encodable = new Map();
/** Caracteres sustituidos por "?" en la última exportación. */
export let replacedChars = 0;
/** Campos de formulario que, por tener algo encima, han pasado a ser parte de la página en la última exportación. */
export let flattenedFields = 0;
/** Convierte el texto a lo que las fuentes estándar (WinAnsi) pueden escribir (igual que al medir en pantalla). */
function clean(s, font) {
  let out = '';
  for (const ch of toPdfText(s, () => replacedChars++)) {
    const k = font.name + ch;
    let ok = encodable.get(k);
    if (ok === undefined) {
      try { font.encodeText(ch); ok = true; } catch { ok = false; }
      encodable.set(k, ok);
    }
    if (!ok) replacedChars++;
    out += ok ? ch : '?';
  }
  return out;
}

// Anchura de un texto sumando las de sus caracteres: pdf-lib incluye el interletraje (kerning) al medir,
// pero no lo aplica al dibujar, así que se mide sin él (igual que en pantalla, donde también está desactivado).
const charWidths = new Map();
function plainWidth(font, text, size) {
  let w = 0;
  for (const ch of text) {
    const key = font.name + '|' + ch;
    let cw = charWidths.get(key);
    if (cw === undefined) { cw = font.widthOfTextAtSize(ch, 1000); charWidths.set(key, cw); }
    w += cw;
  }
  return (w * size) / 1000;
}

function color(hex) {
  const n = parseInt((hex || '#000000').slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function dataUrlToBytes(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Copia en la propia página los atributos heredados del árbol de páginas, para poder reordenarla con seguridad. */
function materializeInherited(page) {
  const n = page.node;
  const keep = (name, v) => { if (v && !n.get(PDFName.of(name))) n.set(PDFName.of(name), v); };
  keep('Resources', n.Resources());
  keep('MediaBox', n.MediaBox());
  keep('CropBox', n.CropBox());
}

const nums = (o) => (o instanceof PDFArray ? o.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : NaN)) : null);
const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/** Rectángulo (en la vista) que ocupa lo que se dibuja de un objeto, con el grosor de su trazo. */
function objRect(o, p) {
  if (o.type === 'text') return textBox(o, p.w);
  const b = getBBox(o);
  const m = (o.color && o.width ? o.width / 2 : 0) + (o.type === 'arrow' ? arrowHead(o).L : 0);
  return { x: b.x - m, y: b.y - m, w: b.w + m * 2, h: b.h + m * 2 };
}

// Anotaciones que sólo son dibujo: las que quedan debajo de algo añadido pasan a ser parte de la página. Las demás
// (notas, adjuntos, enlaces, campos de formulario...) tienen datos que se perderían
const FLATTENABLE = new Set([
  'FreeText', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Ink', 'Stamp', 'Highlight', 'Underline', 'Squiggly',
  'StrikeOut', 'Caret', 'Watermark',
]);

function rectOf(a) {
  const r = nums(a.lookup(PDFName.of('Rect')));
  if (!r || r.length !== 4 || r.some((v) => !Number.isFinite(v))) return null;
  return { x0: Math.min(r[0], r[2]), x1: Math.max(r[0], r[2]), y0: Math.min(r[1], r[3]), y1: Math.max(r[1], r[3]) };
}

/** Apariencia visible de una anotación (su formulario XObject), o null si no tiene o no se ve. */
function appearanceOf(ctx, a) {
  const flags = a.lookup(PDFName.of('F'));
  if (flags instanceof PDFNumber && flags.asNumber() & (0x02 | 0x20)) return null; // oculta
  const ap = a.lookup(PDFName.of('AP'));
  if (!(ap instanceof PDFDict)) return null;
  let ref = ap.get(PDFName.of('N'));
  let form = ref && ctx.lookup(ref);
  if (form instanceof PDFDict) { // una apariencia por estado (p. ej. activada/desactivada): la del estado actual
    const as = a.lookup(PDFName.of('AS'));
    ref = as instanceof PDFName ? form.get(as) : null;
    form = ref && ctx.lookup(ref);
  }
  return ref instanceof PDFRef && form instanceof PDFStream ? { form, ref } : null;
}

/** Parte (de 0 a 1) de un rectángulo que tapan unas zonas. */
function coveredPart(r, zones) {
  const area = (r.x1 - r.x0) * (r.y1 - r.y0);
  if (area <= 0) return 0;
  let sum = 0;
  for (const z of zones) {
    sum += Math.max(0, Math.min(r.x1, z.x1) - Math.max(r.x0, z.x0)) * Math.max(0, Math.min(r.y1, z.y1) - Math.max(r.y0, z.y0));
  }
  return Math.min(1, sum / area);
}

/** Quita un widget del árbol de campos del formulario; si su campo se queda sin widgets, también el campo (y su valor). */
function dropWidget(doc, ref) {
  const ctx = doc.context;
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  const same = (v, r) => v === r || (v instanceof PDFRef && r instanceof PDFRef && v.toString() === r.toString());
  const removeFrom = (arr, r) => {
    if (!(arr instanceof PDFArray)) return;
    for (let i = arr.size() - 1; i >= 0; i--) if (same(arr.get(i), r)) arr.remove(i);
  };
  let cur = ref;
  for (let depth = 0; cur instanceof PDFRef && depth < 20; depth++) {
    const d = ctx.lookup(cur);
    if (!(d instanceof PDFDict)) break;
    if (acro instanceof PDFDict) removeFrom(acro.lookup(PDFName.of('CO')), cur);
    const parent = d.get(PDFName.of('Parent'));
    const pd = parent instanceof PDFRef ? ctx.lookup(parent) : null;
    if (pd instanceof PDFDict) {
      const kids = pd.lookup(PDFName.of('Kids'));
      removeFrom(kids, cur);
      if (kids instanceof PDFArray && kids.size() === 0) { cur = parent; continue; }
      break;
    }
    if (acro instanceof PDFDict) removeFrom(acro.lookup(PDFName.of('Fields')), cur);
    break;
  }
}

/**
 * Las anotaciones (cuadros de texto de otros programas, sellos, dibujos...) se ven siempre por encima del contenido
 * de la página. Las que quedan debajo de algo añadido (rects) pasan a ser parte de la página, con su mismo aspecto,
 * para que lo añadido quede encima como en pantalla; también las que estaban debajo de ellas, para no cambiar el
 * orden. Bajo una zona tapada (white), además, los campos de formulario se convierten igual y se quitan del
 * formulario, y los enlaces y las notas que tapa se quitan. Devuelve los rectángulos (PDF) de lo convertido.
 */
function flattenAnnotsUnder(doc, page, rects, white) {
  const node = page.node;
  const annots = node.Annots();
  const done = [];
  if (!annots || !rects.length) return done;
  const ctx = doc.context;
  // Con /NeedAppearances el programa que rellenó el formulario no actualizó las apariencias de los campos: convertirlas
  // mostraría un valor antiguo (o ninguno)
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  const staleFields = acro instanceof PDFDict && acro.lookup(PDFName.of('NeedAppearances'))?.toString() === 'true';
  const items = annots.asArray().map((ref) => {
    const a = ctx.lookup(ref);
    if (!(a instanceof PDFDict)) return { ref };
    const sub = a.lookup(PDFName.of('Subtype'));
    return { ref, a, kind: sub instanceof PDFName ? sub.asString().slice(1) : '', rect: rectOf(a), ap: appearanceOf(ctx, a) };
  });
  const flat = new Set(), drop = new Set();
  const covered = (it) => {
    const cx = (it.rect.x0 + it.rect.x1) / 2, cy = (it.rect.y0 + it.rect.y1) / 2;
    return white.some((z) => cx >= z.x0 && cx <= z.x1 && cy >= z.y0 && cy <= z.y1) || coveredPart(it.rect, white) >= 0.5;
  };
  for (const it of items) {
    if (!it.a || !it.rect) continue;
    const under = rects.some((z) => overlaps(z, it.rect));
    if (FLATTENABLE.has(it.kind)) {
      if (it.ap && under) flat.add(it);
    } else if (it.kind === 'Widget') {
      // Un campo de formulario con algo encima (un texto escrito sobre él, una firma, una tapa...) pasa a ser parte de
      // la página: si no, su fondo taparía lo añadido en cualquier visor
      if (under && it.ap && !staleFields) flat.add(it);
      else if (covered(it)) drop.add(it);
    } else if (it.kind === 'Link' && white.some((z) => overlaps(z, it.rect))) {
      drop.add(it); // un enlace tapado, aunque sea en parte, no debe seguir llevando a su dirección
    } else if (it.kind === 'Text' && covered(it)) {
      drop.add(it);
    }
  }
  // Lo que estaba debajo de una anotación convertida también se convierte (si no, quedaría encima de ella)
  for (let changed = true; changed;) {
    changed = false;
    items.forEach((it, i) => {
      if (!flat.has(it)) return;
      for (let j = 0; j < i; j++) {
        const u = items[j];
        if (!flat.has(u) && FLATTENABLE.has(u.kind) && u.ap && u.rect && overlaps(u.rect, it.rect)) { flat.add(u); changed = true; }
      }
    });
  }
  if (!flat.size && !drop.size) return done;
  // Las ventanas de comentario (Popup) de lo convertido o quitado sobran
  const gone = new Set([...flat, ...drop].map((it) => String(it.ref)));
  for (const it of [...flat, ...drop]) {
    const pop = it.a.get(PDFName.of('Popup'));
    if (pop) gone.add(String(pop));
  }
  for (const it of items) {
    const parent = it.a?.get(PDFName.of('Parent'));
    if (it.kind === 'Popup' && (gone.has(String(it.ref)) || (parent && gone.has(String(parent))))) drop.add(it);
  }
  // Una copia propia de los recursos de la página (los originales pueden ser también de otras páginas)
  const res = node.Resources();
  if (res instanceof PDFDict) {
    const c = res.clone(ctx);
    for (const k of ['XObject', 'Properties']) {
      const d = c.lookup(PDFName.of(k));
      if (d instanceof PDFDict) c.set(PDFName.of(k), d.clone(ctx));
    }
    node.set(PDFName.of('Resources'), c);
  }
  let props = null;
  const layerName = (oc) => {
    // Una anotación en una capa opcional se dibuja dentro de esa capa: si está apagada sigue sin verse
    if (!props) {
      const r = node.Resources();
      props = r.lookup(PDFName.of('Properties'));
      if (!(props instanceof PDFDict)) { props = ctx.obj({}); r.set(PDFName.of('Properties'), props); }
    }
    const key = props.uniqueKey('OC');
    props.set(key, oc);
    return key.asString();
  };
  let ops = '';
  const f = (v) => +v.toFixed(4);
  for (const it of items) { // en el orden de /Annots, que es el orden en que se dibujan
    if (!flat.has(it)) continue;
    // Del recuadro de la apariencia (transformado por su matriz) al rectángulo de la anotación
    const bb = nums(it.ap.form.dict.lookup(PDFName.of('BBox'))) || [0, 0, 1, 1];
    const m = nums(it.ap.form.dict.lookup(PDFName.of('Matrix'))) || [1, 0, 0, 1, 0, 0];
    const pts = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]]
      .map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    const bx0 = Math.min(...pts.map((q) => q[0])), bx1 = Math.max(...pts.map((q) => q[0]));
    const by0 = Math.min(...pts.map((q) => q[1])), by1 = Math.max(...pts.map((q) => q[1]));
    const { x0, x1, y0, y1 } = it.rect;
    const sx = bx1 > bx0 ? (x1 - x0) / (bx1 - bx0) : 1, sy = by1 > by0 ? (y1 - y0) / (by1 - by0) : 1;
    if (!it.ap.form.dict.get(PDFName.of('Subtype'))) {
      it.ap.form.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
      it.ap.form.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
    }
    const name = node.newXObject('Anot', it.ap.ref);
    const draw = `q ${[sx, 0, 0, sy, x0 - bx0 * sx, y0 - by0 * sy].map(f).join(' ')} cm ${name.asString()} Do Q`;
    const oc = it.a.get(PDFName.of('OC'));
    ops += (oc ? `/OC ${layerName(oc)} BDC ${draw} EMC` : draw) + '\n';
    done.push(it.rect);
    // (los que quedan bajo una tapa se quitan a propósito: no hace falta avisar de ellos)
    if (it.kind === 'Widget' && !white.some((z) => overlaps(z, it.rect))) flattenedFields++;
  }
  node.set(PDFName.of('Annots'), ctx.obj(items.filter((it) => !flat.has(it) && !drop.has(it)).map((it) => it.ref)));
  for (const it of [...flat, ...drop]) if (it.kind === 'Widget') dropWidget(doc, it.ref);
  // Lo quitado puede seguir siendo alcanzable (p. ej. desde la estructura de un PDF etiquetado): se vacían sus datos
  // (dirección del enlace, valor del campo, comentario...) para que no queden dentro del archivo
  const KEEP = new Set(['/Type', '/Subtype', '/Rect', '/F', '/P', '/StructParent']);
  for (const it of [...flat, ...drop]) {
    for (const k of it.a.keys()) if (!KEEP.has(k.asString())) it.a.delete(k);
  }
  if (ops) node.addContentStream(ctx.register(ctx.flateStream(new TextEncoder().encode(ops))));
  return done;
}

/**
 * Quita de la página las anotaciones de texto sustituidas por su edición, con sus ventanas de comentario, y vacía sus
 * datos: pueden seguir enlazadas desde otro sitio (una respuesta, la estructura de un PDF etiquetado) y su texto
 * antiguo no debe quedar dentro del archivo.
 */
function dropEditedAnnots(doc, node, indexes) {
  const arr = node.Annots();
  if (!arr) return;
  const ctx = doc.context;
  const refs = indexes.map((i) => arr.get(i)).filter((r) => r instanceof PDFRef);
  const gone = new Set(refs.map(String));
  const all = [...indexes];
  arr.asArray().forEach((r, i) => {
    const d = ctx.lookup(r);
    if (d instanceof PDFDict && d.get(PDFName.of('Subtype'))?.toString() === '/Popup' && gone.has(String(d.get(PDFName.of('Parent'))))) all.push(i);
  });
  const KEEP = new Set(['/Type', '/Subtype', '/Rect', '/F', '/P', '/StructParent']);
  for (const r of refs) {
    const d = ctx.lookup(r);
    if (d instanceof PDFDict) for (const k of d.keys()) if (!KEEP.has(k.asString())) d.delete(k);
  }
  removeAnnotsAt(node, all);
}

export async function buildPdf() {
  replacedChars = 0;
  flattenedFields = 0;
  // Se trabaja con una copia de las páginas tal y como están ahora: si mientras se genera el PDF se deshace o se
  // cambia algo, el resultado no se mezcla
  const pages = JSON.parse(JSON.stringify(state.pages));
  await fontsReady; // el ajuste de líneas se mide con las fuentes de pantalla
  const loaded = new Map(); // id de origen -> PDFDocument de pdf-lib
  const firstSrc = pages.find((p) => p.src != null)?.src;
  let out;
  if (firstSrc != null) {
    out = await PDFDocument.load(state.sources.get(firstSrc).bytes, { ignoreEncryption: true, updateMetadata: false });
    if (out.isEncrypted) throw new Error(t('Este PDF está protegido con contraseña o cifrado y no se puede guardar con cambios.'));
    loaded.set(firstSrc, out);
  } else {
    out = await PDFDocument.create();
  }

  // 1) Reunir las páginas en el orden final
  const used = new Set();
  const finalPages = [];
  const annotIdx = []; // por página: posiciones en /Annots de las anotaciones de texto sustituidas por su edición
  for (const p of pages) {
    let page, srcNode = null;
    if (p.src == null) {
      page = PDFPage.create(out);
      page.setSize(p.w, p.h);
    } else if (p.src === firstSrc && !used.has(p.index)) {
      page = out.getPage(p.index);
      used.add(p.index);
      materializeInherited(page);
      srcNode = page.node;
    } else {
      let doc = loaded.get(p.src);
      if (!doc) {
        doc = await PDFDocument.load(state.sources.get(p.src).bytes, { ignoreEncryption: true });
        if (doc.isEncrypted) throw new Error(t('"{nombre}" está cifrado y no se puede combinar.', { nombre: state.sources.get(p.src).name }));
        loaded.set(p.src, doc);
      }
      srcNode = doc.getPage(p.index).node;
      [page] = await out.copyPages(doc, [p.index]);
    }
    // Una copia conserva el orden de /Annots de su original: se buscan ahora, antes de modificar nada
    const refs = p.objects.filter((o) => o.annot && !isNoopEdit(o)).map((o) => o.annot.ref);
    annotIdx.push(srcNode && refs.length ? annotIndexes(srcNode, refs) : []);
    finalPages.push(page);
  }

  // 2) Sustituir el árbol de páginas por el nuevo orden
  for (let i = out.getPageCount() - 1; i >= 0; i--) out.removePage(i);
  for (const page of finalPages) out.addPage(page);

  // Zona de cada línea original editada (crece si su caja ocupa más líneas que la original)
  const zones = new Map();
  const pageLines = new Map();
  for (const p of pages) {
    if (p.objects.some((o) => o.cover && !o.annot)) pageLines.set(p, await getLines(p));
  }
  const specOf = (o, p) => {
    if (!zones.has(o)) zones.set(o, lineSpec(o, p, pageLines.get(p) || []));
    return zones.get(o);
  };
  const partsOf = (o, p) => specOf(o, p).parts;
  const editedLines = (p) => (p.src == null ? [] : p.objects.filter((o) => o.cover && !o.annot && !o.ocr && !isNoopEdit(o)));
  // Líneas reconocidas con OCR: su texto es parte de una imagen y no se puede quitar; siempre se tapa
  const ocrEdits = (p) => (p.src == null ? [] : p.objects.filter((o) => o.ocr && o.cover && !isNoopEdit(o)));

  // 3) Quitar del contenido el texto original que se ha editado o tapado, y las anotaciones de texto editadas
  const removalFailed = new Set();
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const toPdf = viewToPdf(p.view, p.baseRotate || 0);
    const rects = editedLines(p).flatMap((o) => partsOf(o, p));
    if (p.src != null) for (const o of p.objects) if (o.whiteout) rects.push(o);
    if (rects.length) {
      try {
        removeTextInZones(out, finalPages[i], rects.map((b) => pdfZone(toPdf, b)));
      } catch (err) {
        removalFailed.add(i);
        console.warn(`Página ${i + 1}: el texto original queda tapado pero no eliminado`, err);
      }
    }
    if (annotIdx[i].length) dropEditedAnnots(out, finalPages[i].node, annotIdx[i]);
  }

  // Imágenes del PDF original movidas, sustituidas o eliminadas: se quita la original. Si no se encuentra (p. ej. una
  // imagen dentro del contenido de otra forma), se tapa con blanco
  const imgCovers = new Map(); // página -> zonas que tapar
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (p.src == null) continue;
    const objs = p.objects.filter((o) => o.origImg && !isNoopEdit(o));
    if (!objs.length) continue;
    const toPdf = viewToPdf(p.view, p.baseRotate || 0);
    const zs = objs.map((o) => ({ ...pdfZone(toPdf, o.origImg), img: true }));
    try {
      removeTextInZones(out, finalPages[i], zs);
    } catch (err) {
      console.warn(`Página ${i + 1}: la imagen original queda tapada`, err);
    }
    const bad = objs.filter((o, k) => !zs[k].removedImg).map((o) => o.origImg);
    if (bad.length) imgCovers.set(p, bad);
  }

  // El texto original que no se pudo quitar del todo (p. ej. si está dentro de un formulario XObject) se tapa con
  // el color del fondo, como se ve en pantalla. El que sí se quitó no se tapa: así no se borra nada de alrededor
  // (las líneas de una tabla, un fondo de color...)
  const mustCover = new Set();
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    for (const o of ocrEdits(p)) mustCover.add(o);
    const objs = editedLines(p);
    if (!objs.length) continue;
    if (removalFailed.has(i)) { objs.forEach((o) => mustCover.add(o)); continue; }
    const specs = objs.map((o) => specOf(o, p));
    const bad = await failedKeys(p, specs);
    for (const s of specs) if (bad.has(s.key)) mustCover.add(s.o);
  }

  // Anotaciones que quedan debajo de algo añadido: pasan a ser parte de la página (ver flattenAnnotsUnder)
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const objs = p.objects.filter((o) => !isNoopEdit(o));
    if (!objs.length || !finalPages[i].node.Annots()) continue;
    const toPdf = viewToPdf(p.view, p.baseRotate || 0);
    const rects = [];
    for (const o of objs) {
      if (o.type !== 'text' || o.text) rects.push(pdfZone(toPdf, objRect(o, p)));
      if (mustCover.has(o)) for (const r of partsOf(o, p)) rects.push(pdfZone(toPdf, r));
    }
    const white = p.objects.filter((o) => o.whiteout).map((o) => pdfZone(toPdf, o));
    const flat = flattenAnnotsUnder(out, finalPages[i], rects, white);
    // El texto de esas anotaciones que queda bajo una zona tapada también se elimina del archivo, como el de la página
    if (white.some((z) => flat.some((r) => overlaps(z, r)))) {
      try {
        removeTextInZones(out, finalPages[i], white);
      } catch (err) {
        console.warn(`Página ${i + 1}: el texto de las anotaciones tapadas queda tapado pero no eliminado`, err);
      }
    }
  }

  // 4) Dibujar los objetos de cada página
  const fonts = {};
  const getFont = async (fam, bold, italic) => {
    const i = (bold ? 1 : 0) + (italic ? 2 : 0);
    const key = fam + i;
    return (fonts[key] ||= await out.embedFont((FONT_MAP[fam] || FONT_MAP.sans)[i]));
  };
  const images = {};

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const page = finalPages[i];
    const R = p.baseRotate || 0;
    page.setRotation(degrees((R + p.rotation) % 360));
    if (!p.objects.some((o) => !isNoopEdit(o)) && !imgCovers.has(p)) continue;

    const P = viewToPdf(p.view, R);
    const fmt = (x, y) => { const [X, Y] = P(x, y); return `${X.toFixed(3)} ${(-Y).toFixed(3)}`; };
    const poly = (pts, close) => pts.map((q, k) => (k ? 'L' : 'M') + fmt(q[0], q[1])).join(' ') + (close ? ' Z' : '');
    const rectPts = (b) => [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
    const draw = (d, opts) => page.drawSvgPath(d, { x: 0, y: 0, color: undefined, ...opts });
    // Una sola entrada de recursos por fuente y página (pdf-lib crearía una nueva en cada llamada a drawText)
    const fontKeys = new Map();
    const keyOf = (font) => {
      if (!fontKeys.has(font)) fontKeys.set(font, page.node.newFontDictionary(font.name, font.ref));
      return fontKeys.get(font);
    };

    // Las líneas originales abiertas pero sin cambios no se tocan
    const objects = p.objects.filter((o) => !isNoopEdit(o));

    // Las tapas del texto original que no se pudo quitar van debajo de todo lo demás
    for (const r of imgCovers.get(p) || []) draw(poly(rectPts(r), true), { color: rgb(1, 1, 1), borderWidth: 0 });
    for (const o of objects) {
      if (mustCover.has(o)) for (const r of partsOf(o, p)) draw(poly(rectPts(r), true), { color: color(o.cover.color), borderWidth: 0 });
    }

    for (const o of objects) {
      const op = o.opacity ?? 1;
      switch (o.type) {
        case 'text': {
          if (!o.text) break;
          // Escala horizontal que conserva el ancho de la línea original (con las fuentes del PDF)
          let hs = 1;
          if (o.orig?.w && !o.noScale) {
            let w = 0;
            const counted = replacedChars;
            for (const r of o.orig.runs) {
              const f = await getFont(r.family, r.bold, r.italic);
              w += plainWidth(f, clean(r.text, f), o.orig.size);
            }
            replacedChars = counted;
            if (w > 0) hs = clampScale(o.orig.w / w);
          }
          // Las mismas líneas que se ven en pantalla, con cada trozo en la posición medida en pantalla.
          // Se escribe un único bloque de texto por caja (más compacto que una llamada a drawText por trozo).
          const lines = layoutTextLines(o, p.w);
          const { baseline, pitch } = textMetrics(o.family, o.size);
          // Las letras que tapa una zona tapada dibujada encima no se escriben (como el texto del PDF bajo una tapa)
          const idx = p.objects.indexOf(o);
          const above = p.objects.filter((w, j) => w.whiteout && j > idx);
          const hidden = (vx, vy) => above.some((w) => vx >= w.x && vx <= w.x + w.w && vy >= w.y && vy <= w.y + w.h);
          const ops = [pushGraphicsState()];
          if (op < 1) ops.push(setGraphicsState(page.node.newExtGState('GS', out.context.obj({ Type: 'ExtGState', ca: op, CA: op }))));
          ops.push(beginText());
          // Un texto añadido en una página que se veía girada lleva su propio giro
          const angle = toRadians(degrees(R - rotOf(o)));
          let curFont = null, curColor = null, curTz = 1;
          for (let k = 0; k < lines.length; k++) {
            const ly = baseline + k * pitch; // línea base, medida desde la esquina del texto
            for (const piece of lines[k]) {
              const font = await getFont(piece.family, piece.bold, piece.italic);
              const t = clean(piece.text, font);
              if (!t) continue;
              // Un carácter especial ocupa en el PDF exactamente el ancho que tiene en pantalla
              let tz = hs;
              if (piece.special && piece.w > 0) {
                const pw = plainWidth(font, t, o.size);
                if (pw > 0) tz = hs * Math.min(2, Math.max(0.5, piece.w / pw));
              }
              if (font !== curFont) { ops.push(setFontAndSize(keyOf(font), o.size)); curFont = font; }
              const col = piece.color || o.color;
              if (col !== curColor) { ops.push(setFillingColor(color(col))); curColor = col; }
              if (Math.abs(tz - curTz) > 1e-4) { ops.push(setCharacterSqueeze(tz * 100)); curTz = tz; }
              const write = (str, lx) => {
                const [X, Y] = P(...objPoint(o, lx, ly));
                ops.push(rotateAndSkewTextRadiansAndTranslate(angle, 0, 0, X, Y), showText(font.encodeText(str)));
              };
              const x0 = piece.x * hs;
              if (!above.length) { write(t, x0); continue; }
              // Letra a letra, por su centro (en el PDF cada letra avanza su ancho en la fuente, con la escala horizontal)
              const cy = ly - 0.35 * o.size;
              let run = '', runX = x0, cx = x0;
              for (const ch of t) {
                const adv = plainWidth(font, ch, o.size) * tz;
                if (hidden(...objPoint(o, cx + adv / 2, cy))) { if (run) write(run, runX); run = ''; } else { if (!run) runX = cx; run += ch; }
                cx += adv;
              }
              if (run) write(run, runX);
            }
          }
          ops.push(endText(), popGraphicsState());
          page.pushOperators(...ops);
          break;
        }
        case 'image': {
          const a = state.assets[o.asset];
          if (!a || o.removed) break;
          if (!images[o.asset]) {
            const bytes = dataUrlToBytes(a.src);
            images[o.asset] = a.mime === 'image/jpeg' ? await out.embedJpg(bytes) : await out.embedPng(bytes);
          }
          // Su esquina de abajo a la izquierda (con el giro propio, si se añadió en una página que se veía girada)
          const [X, Y] = P(...objPoint(o, 0, o.h));
          page.drawImage(images[o.asset], { x: X, y: Y, width: o.w, height: o.h, rotate: degrees(R - rotOf(o)), opacity: op });
          break;
        }
        case 'rect':
        case 'highlight': {
          const opts = { borderWidth: 0 };
          if (o.type === 'highlight') Object.assign(opts, { color: color(o.color), opacity: op, blendMode: BlendMode.Multiply });
          else {
            if (o.fill) Object.assign(opts, { color: color(o.fill), opacity: op });
            if (o.color && o.width) Object.assign(opts, { borderColor: color(o.color), borderWidth: o.width, borderOpacity: op });
          }
          if (opts.color || opts.borderColor) draw(poly(rectPts(o), true), opts);
          break;
        }
        case 'ellipse': {
          const cx = o.x + o.w / 2, cy = o.y + o.h / 2, rx = o.w / 2, ry = o.h / 2, k = ellipseK;
          const C = (a, b, c) => ` C ${fmt(...a)} ${fmt(...b)} ${fmt(...c)}`;
          const d = `M ${fmt(cx + rx, cy)}` +
            C([cx + rx, cy + k * ry], [cx + k * rx, cy + ry], [cx, cy + ry]) +
            C([cx - k * rx, cy + ry], [cx - rx, cy + k * ry], [cx - rx, cy]) +
            C([cx - rx, cy - k * ry], [cx - k * rx, cy - ry], [cx, cy - ry]) +
            C([cx + k * rx, cy - ry], [cx + rx, cy - k * ry], [cx + rx, cy]) + ' Z';
          const opts = { borderWidth: 0 };
          if (o.fill) Object.assign(opts, { color: color(o.fill), opacity: op });
          if (o.color && o.width) Object.assign(opts, { borderColor: color(o.color), borderWidth: o.width, borderOpacity: op });
          if (opts.color || opts.borderColor) draw(d, opts);
          break;
        }
        case 'note': {
          // Nota (comentario) como anotación de texto del PDF: Acrobat y los demás lectores la muestran como un icono
          const [X, Y] = P(o.x, o.y);
          const [X2, Y2] = P(o.x + o.w, o.y + o.h);
          const annot = out.context.obj({
            Type: 'Annot', Subtype: 'Text', Name: 'Comment', Open: false, F: 4,
            Rect: [Math.min(X, X2), Math.min(Y, Y2), Math.max(X, X2), Math.max(Y, Y2)],
            Contents: PDFHexString.fromText(o.text || ''), T: PDFHexString.fromText('PDF Stroke'),
            M: PDFString.fromDate(new Date()), C: [1, 0.84, 0.31],
          });
          page.node.addAnnot(out.context.register(annot));
          break;
        }
        case 'ink':
        case 'line':
        case 'arrow': {
          const stroke = { borderColor: color(o.color), borderWidth: o.width, borderOpacity: op, borderLineCap: LineCapStyle.Round };
          let pts;
          if (o.type === 'ink') pts = o.points;
          else if (o.type === 'line') pts = [[o.x1, o.y1], [o.x2, o.y2]];
          else pts = [[o.x1, o.y1], arrowHead(o).base];
          page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round));
          draw(poly(pts, false), stroke);
          page.pushOperators(popGraphicsState());
          if (o.type === 'arrow') {
            const h = arrowHead(o);
            draw(poly([h.tip, h.left, h.right], true), { color: color(o.color), opacity: op, borderWidth: 0 });
          }
          break;
        }
      }
    }
  }

  out.setProducer('PDF Stroke');
  out.setModificationDate(new Date());
  await out.flush();
  collectGarbage(out);
  return out.save();
}
