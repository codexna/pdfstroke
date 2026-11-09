// Página modificada: para mostrar una línea original editada (o una anotación de texto editada) no se pinta un
// rectángulo encima, sino que se quita de verdad del PDF, con el mismo código que al guardar, y en pantalla se
// sustituye sólo esa zona por la página ya modificada. Así las líneas de una tabla, los fondos de color y lo que
// haya alrededor se ven intactos, exactamente igual que en el PDF guardado.
import { state, isNoopEdit } from './state.js';
import { linesSync } from './textlayer.js';
import { coverRect, textBox, zoneParts } from './objects.js';
import { removeTextInZones } from './textremove.js';

const { PDFDocument, PDFPage, PDFName, PDFRef, PDFObjectCopier } = PDFLib;

/**
 * Devuelve una función que pasa de coordenadas de vista (escala 1, con la rotación propia de la página,
 * origen arriba a la izquierda, como las usa pdf.js) a coordenadas de usuario del PDF.
 */
export function viewToPdf(view, rotation) {
  const [x0, y0, x1, y1] = view;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let a, b, c, d;
  switch (rotation) {
    case 90: [a, b, c, d] = [0, 1, 1, 0]; break;
    case 180: [a, b, c, d] = [-1, 0, 0, 1]; break;
    case 270: [a, b, c, d] = [0, -1, -1, 0]; break;
    default: [a, b, c, d] = [1, 0, 0, -1];
  }
  const ox = a === 0 ? Math.abs(cy - y0) : Math.abs(cx - x0);
  const oy = a === 0 ? Math.abs(cx - x0) : Math.abs(cy - y0);
  const e = ox - a * cx - c * cy;
  const f = oy - b * cx - d * cy;
  const det = a * d - b * c;
  return (x, y) => [(x * d - y * c + c * f - e * d) / det, (-x * b + y * a + e * b - f * a) / det];
}

/** Rectángulo de vista convertido en zona del PDF ({ x0, y0, x1, y1 }). */
export function pdfZone(toPdf, b) {
  const pts = [toPdf(b.x, b.y), toPdf(b.x + b.w, b.y + b.h)];
  return {
    x0: Math.min(pts[0][0], pts[1][0]), x1: Math.max(pts[0][0], pts[1][0]),
    y0: Math.min(pts[0][1], pts[1][1]), y1: Math.max(pts[0][1], pts[1][1]),
  };
}

/** Identificador de una referencia de pdf-lib con el formato que usa pdf.js para las anotaciones ("12R"). */
const refId = (r) => r.objectNumber + 'R' + (r.generationNumber ? r.generationNumber : '');

/** Posiciones, dentro del /Annots de una página, de las anotaciones indicadas (por su identificador de pdf.js). */
export function annotIndexes(node, ids) {
  const arr = node.Annots();
  if (!arr || !ids.length) return [];
  const want = new Set(ids);
  const out = [];
  arr.asArray().forEach((r, i) => { if (r instanceof PDFRef && want.has(refId(r))) out.push(i); });
  return out;
}

/** Quita de /Annots las anotaciones en esas posiciones. */
export function removeAnnotsAt(node, indexes) {
  const arr = node.Annots();
  if (!arr) return;
  for (const i of [...new Set(indexes)].sort((a, b) => b - a)) if (i < arr.size()) arr.remove(i);
}

const r2 = (v) => Math.round(v * 100) / 100;
const grow = (b, m) => ({ x: b.x - m, y: b.y - m, w: b.w + m * 2, h: b.h + m * 2 });

/** Zona de la que se quita el texto original de una línea editada (crece si su caja ocupa más líneas). */
export function lineZone(o, p, lines = linesSync(p) || []) {
  return coverRect(o, textBox(o, p.w), lines);
}

export const zoneKey = (z) => [z.x, z.y, z.w, z.h].map(r2).join(',');

/**
 * Lo que oculta una línea editada: su zona (el rectángulo que lo abarca todo), las partes de las que se quita el texto
 * y la clave que la identifica (la misma en pantalla y al guardar).
 */
export function lineSpec(o, p, lines = linesSync(p) || []) {
  const zone = lineZone(o, p, lines);
  const parts = zoneParts(zone);
  // Con margen: los trazos de algunas letras (cursivas, acentos, colas) salen de la caja de la línea
  return { id: o.id, o, zone, parts, rect: grow(zone, Math.max(2, o.size * 0.5)), key: 'Z' + parts.map(zoneKey).join(';') };
}

/**
 * Lo que oculta contenido original en una página: líneas editadas (se quita su texto de una zona) y anotaciones
 * de texto editadas (se quita la anotación). `rect` es la parte de la página que se sustituye en pantalla.
 */
export function hiderSpecs(p) {
  if (p.src == null) return [];
  const lines = linesSync(p) || [];
  const out = [];
  for (const o of p.objects) {
    // Imagen del PDF original movida, cambiada o eliminada: se quita la original de su sitio
    if (o.origImg) {
      if (!isNoopEdit(o)) {
        const zone = { x: o.origImg.x, y: o.origImg.y, w: o.origImg.w, h: o.origImg.h };
        out.push({ id: o.id, o, zone, img: true, rect: grow(zone, 0.5), key: 'I' + zoneKey(zone) });
      }
      continue;
    }
    // Las líneas reconocidas con OCR son parte de una imagen: no hay texto que quitar, se tapan siempre
    if (o.type !== 'text' || !o.cover || o.ocr) continue;
    if (o.annot) {
      out.push({ id: o.id, ref: o.annot.ref, rect: grow(o.annot, 1), key: 'A' + o.annot.ref });
    } else {
      out.push(lineSpec(o, p, lines));
    }
  }
  return out;
}

/** Clave de un conjunto de zonas (independiente del orden y de qué objeto las causa). */
export const specsKey = (specs) => [...new Set(specs.map((s) => s.key))].sort().join('|');

// ---------- Construcción de la página modificada ----------
const libDocs = new Map(); // id de origen -> Promise<PDFDocument> (sin modificar; sólo se copian páginas de él)
/** El documento de origen abierto con pdf-lib (sólo para leerlo: nunca se modifica). */
export function sourceLib(srcId) {
  if (!libDocs.has(srcId)) {
    const src = state.sources.get(srcId);
    libDocs.set(srcId, PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false }));
  }
  return libDocs.get(srcId);
}

let worker = null;
const previewWorker = () => (worker ||= new pdfjsLib.PDFWorker({ name: 'vista-previa' }));

/** Centros de letra que quedan dentro de alguna zona tras quitar el texto (p. ej. texto dentro de un formulario XObject). */
async function remainingIn(page, specs) {
  const bad = new Set();
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    const t = pdfjsLib.Util.transform(vp.transform, it.transform);
    const size = Math.hypot(t[2], t[3]) || 1;
    // La posición de cada letra se estima repartiendo el ancho por igual: cerca de los lados de la zona podría caer
    // dentro una letra vecina que en realidad está fuera, así que esos márgenes no cuentan
    const inside = (z, x, y) => {
      const m = Math.min(size * 0.5, z.w * 0.25);
      return x > z.x + m && x < z.x + z.w - m && y > z.y + 0.3 && y < z.y + z.h - 0.3;
    };
    const run = Math.hypot(t[0], t[1]) || 1;
    const ux = t[0] / run, uy = t[1] / run, vx = t[2] / size, vy = t[3] / size;
    const chars = [...it.str];
    const len = it.width * vp.scale;
    chars.forEach((ch, i) => {
      if (!ch.trim()) return;
      const d = ((i + 0.5) / chars.length) * len;
      // Centro aproximado de la letra: sobre la línea base, a algo más de un tercio de su altura
      const x = t[4] + ux * d + vx * 0.35 * size, y = t[5] + uy * d + vy * 0.35 * size;
      for (const s of specs) if ((s.parts || [s.zone]).some((z) => inside(z, x, y))) bad.add(s.key);
    });
  }
  return bad;
}

async function build(p, specs) {
  const lib = await sourceLib(p.src);
  // Con el contenido cifrado no se puede quitar nada (y la copia no se vería): se tapa como antes
  if (lib.isEncrypted) throw new Error('Documento cifrado');
  const tmp = await PDFDocument.create({ updateMetadata: false });
  // Copia de la página y de las capas opcionales del documento (con el mismo copiador, para que lo que está
  // oculto en el original siga oculto en la copia)
  const copier = PDFObjectCopier.for(lib.context, tmp.context);
  const node = copier.copy(lib.getPage(p.index).node);
  const page = PDFPage.of(node, tmp.context.register(node), tmp);
  tmp.addPage(page);
  const oc = lib.catalog.get(PDFName.of('OCProperties'));
  if (oc) tmp.catalog.set(PDFName.of('OCProperties'), copier.copy(oc));
  const failed = new Set();
  // Anotaciones editadas: fuera de la página (la copia conserva el orden de /Annots del original)
  const annots = specs.filter((s) => s.ref);
  if (annots.length) {
    const srcNode = lib.getPage(p.index).node;
    const idx = [];
    for (const s of annots) {
      const found = annotIndexes(srcNode, [s.ref]);
      if (found.length) idx.push(...found);
      else failed.add(s.key);
    }
    removeAnnotsAt(page.node, idx);
  }
  // Texto original de las líneas editadas: se quita del contenido de la página
  const zoned = specs.filter((s) => s.zone);
  if (zoned.length) {
    const toPdf = viewToPdf(p.view, p.baseRotate || 0);
    const zones = [], owner = [];
    zoned.forEach((s, i) => { for (const r of s.parts || [s.zone]) { zones.push({ ...pdfZone(toPdf, r), img: !!s.img }); owner.push(i); } });
    try {
      removeTextInZones(tmp, page, zones);
      // Si había texto invisible (la capa de OCR de un escaneo) o el texto estaba debajo de una imagen, lo que se ve
      // allí es la imagen: quitar el texto no lo borra de la vista, así que hay que taparlo
      zoned.forEach((s, i) => {
        if (zones.some((z, k) => owner[k] === i && (z.invisible || z.imageAfter || (z.img && !z.removedImg)))) failed.add(s.key);
      });
    } catch (err) {
      console.warn('No se pudo quitar el texto original de la vista previa', err);
      zoned.forEach((s) => failed.add(s.key));
    }
  }
  const bytes = await tmp.save({ useObjectStreams: false });
  const doc = await pdfjsLib.getDocument({
    data: bytes, worker: previewWorker(), cMapUrl: 'vendor/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/standard_fonts/',
  }).promise;
  const pdfPage = await doc.getPage(1);
  const textZoned = zoned.filter((s) => !s.img && !failed.has(s.key));
  if (textZoned.length) for (const k of await remainingIn(pdfPage, textZoned)) failed.add(k);
  return { doc, page: pdfPage, failed };
}

const previews = new Map(); // "origen:página|zonas" -> Promise<{ doc, page, failed: Set<clave> }>
const results = new Map();  // "origen:página|clave de zona" -> true si el texto se quitó del todo
const MAX_PREVIEWS = 6;

/** Página modificada (con caché): se construye una vez por conjunto de zonas. */
export function getPreview(p, specs) {
  const key = p.src + ':' + p.index + '|' + specsKey(specs);
  let pr = previews.get(key);
  if (!pr) {
    pr = build(p, specs).catch((err) => {
      console.warn('Vista previa no disponible: se tapará el texto original', err);
      return { doc: null, page: null, failed: new Set(specs.map((s) => s.key)) };
    }).then((pv) => {
      for (const s of specs) results.set(p.src + ':' + p.index + '|' + s.key, !pv.failed.has(s.key));
      return pv;
    });
    previews.set(key, pr);
    // Se conservan sólo las últimas (cada una es un documento abierto en memoria)
    while (previews.size > MAX_PREVIEWS) {
      const [oldKey, old] = previews.entries().next().value;
      previews.delete(oldKey);
      old.then((pv) => pv.doc?.destroy()).catch(() => {});
    }
  } else {
    // Usada ahora: pasa a ser la más reciente
    previews.delete(key);
    previews.set(key, pr);
  }
  return pr;
}

/** Claves de las zonas cuyo texto original no se pudo quitar del todo (al guardar, ésas se tapan). */
export async function failedKeys(p, specs) {
  const base = p.src + ':' + p.index + '|';
  const unknown = specs.filter((s) => !results.has(base + s.key));
  if (unknown.length) await getPreview(p, unknown);
  return new Set(specs.filter((s) => results.get(base + s.key) === false).map((s) => s.key));
}

/** Olvida lo calculado para un documento que se ha cerrado. */
export function dropSource(srcId) {
  libDocs.delete(srcId);
  for (const [key, pr] of previews) {
    if (key.startsWith(srcId + ':')) { previews.delete(key); pr.then((pv) => pv.doc?.destroy()).catch(() => {}); }
  }
  for (const key of results.keys()) if (key.startsWith(srcId + ':')) results.delete(key);
}
