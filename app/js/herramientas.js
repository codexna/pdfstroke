// Herramientas sobre el PDF ya generado (con los cambios hechos en el editor): comprimir, extraer o dividir páginas,
// marca de agua y números de página. Todo con pdf-lib, en el propio dispositivo.
import { t } from './i18n.js';
import { zip } from './word.js';

const {
  PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFDict, StandardFonts, rgb, degrees, decodePDFRawStream,
} = PDFLib;

// ---------- Comprimir ----------
const NIVELES = {
  // lado mayor máximo de cada imagen (píxeles) y calidad JPEG
  baja: { lado: 2400, calidad: 0.82 },
  media: { lado: 1600, calidad: 0.7 },
  alta: { lado: 1100, calidad: 0.55 },
};

function nameOf(v) { return v instanceof PDFName ? v.asString() : null; }

async function bitmapFromJpeg(bytes) {
  return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
}

function canvasToJpeg(c, q) {
  return new Promise((res) => c.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), 'image/jpeg', q));
}

/**
 * Reduce el tamaño de las imágenes (fotos y escaneos), que es lo que más ocupa en casi todos los PDF; el texto y los
 * dibujos no cambian. Devuelve { bytes, antes, despues, imagenes } (imagenes = cuántas se han reducido).
 */
export async function comprimir(bytes, nivel = 'media', onProgress = () => {}) {
  const { lado, calidad } = NIVELES[nivel] || NIVELES.media;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const objs = ctx.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && nameOf(o.dict.lookup(PDFName.of('Subtype'))) === '/Image');
  let hechas = 0;
  for (let k = 0; k < objs.length; k++) {
    const [ref, s] = objs[k];
    onProgress(k + 1, objs.length);
    try {
      const d = s.dict;
      const filtro = d.lookup(PDFName.of('Filter'));
      const f = nameOf(filtro) || (filtro?.asArray?.().length === 1 ? nameOf(ctx.lookup(filtro.asArray()[0])) : null);
      const cs = d.lookup(PDFName.of('ColorSpace'));
      const csName = nameOf(cs);
      const bpc = d.lookup(PDFName.of('BitsPerComponent'))?.asNumber?.();
      const W = d.lookup(PDFName.of('Width'))?.asNumber?.(), H = d.lookup(PDFName.of('Height'))?.asNumber?.();
      if (!W || !H || d.lookup(PDFName.of('ImageMask')) || d.lookup(PDFName.of('Decode')) || d.lookup(PDFName.of('Mask'))) continue;
      if (csName !== '/DeviceRGB' && csName !== '/DeviceGray') continue; // CMYK, indexadas, ICC…: se dejan
      const gris = csName === '/DeviceGray';
      const antes = s.contents.length;
      if (antes < 20000) continue; // las pequeñas apenas ocupan
      let bmp;
      if (f === '/DCTDecode') {
        bmp = await bitmapFromJpeg(s.contents);
      } else if (f === '/FlateDecode' && bpc === 8) {
        // Sin pérdida (p. ej. capturas): solo si es grande; se pasa a JPEG
        const raw = decodePDFRawStream(s).decode();
        const comps = gris ? 1 : 3;
        if (raw.length < W * H * comps) continue;
        const c = new OffscreenCanvas(W, H);
        const g = c.getContext('2d');
        const id = g.createImageData(W, H);
        for (let i = 0, j = 0; i < W * H; i++, j += comps) {
          id.data[i * 4] = raw[j];
          id.data[i * 4 + 1] = gris ? raw[j] : raw[j + 1];
          id.data[i * 4 + 2] = gris ? raw[j] : raw[j + 2];
          id.data[i * 4 + 3] = 255;
        }
        g.putImageData(id, 0, 0);
        bmp = c.transferToImageBitmap();
      } else continue;
      const k2 = Math.min(1, lado / Math.max(W, H));
      const w = Math.max(1, Math.round(W * k2)), h = Math.max(1, Math.round(H * k2));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, w, h);
      bmp.close?.();
      if (gris) {
        const id = g.getImageData(0, 0, w, h);
        for (let i = 0; i < id.data.length; i += 4) { const v = (id.data[i] + id.data[i + 1] + id.data[i + 2]) / 3; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; }
        g.putImageData(id, 0, 0);
      }
      const jpg = await canvasToJpeg(c, calidad);
      if (jpg.length >= antes * 0.9) continue; // no compensa
      const nd = d.clone(ctx);
      nd.set(PDFName.of('Width'), PDFNumber.of(w));
      nd.set(PDFName.of('Height'), PDFNumber.of(h));
      nd.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
      nd.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
      nd.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      nd.delete(PDFName.of('DecodeParms'));
      nd.delete(PDFName.of('Length'));
      ctx.assign(ref, PDFRawStream.of(nd, jpg));
      hechas++;
    } catch (err) {
      console.warn('Imagen no comprimida', err);
    }
  }
  // Metadatos XMP (a veces ocupan mucho) y miniaturas incrustadas fuera
  doc.catalog.delete(PDFName.of('Metadata'));
  for (const page of doc.getPages()) page.node.delete(PDFName.of('Thumb'));
  const out = await doc.save({ useObjectStreams: true });
  return { bytes: out, antes: bytes.length, despues: out.length, imagenes: hechas };
}

export function tamano(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}

// ---------- Extraer / dividir ----------
/** «1-3, 5, 8-» → índices (desde 0) en orden; null si no es válido. */
export function parseRangos(txt, n) {
  const out = [];
  for (const part of txt.split(/[,;]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part) || /^(\d+)$/.exec(part);
    if (!m) return null;
    let a, b;
    if (m.length === 2) { a = b = +m[1]; } else { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
    if (a < 1 || b > n || a > b) return null;
    for (let i = a; i <= b; i++) out.push(i - 1);
  }
  return out.length ? out : null;
}

export async function extraer(bytes, indices) {
  const src = await PDFDocument.load(bytes, { updateMetadata: false });
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

/** Cada página en un PDF aparte, todos dentro de un .zip. */
export async function dividir(bytes, base, onProgress = () => {}) {
  const src = await PDFDocument.load(bytes, { updateMetadata: false });
  const n = src.getPageCount();
  const files = [];
  for (let i = 0; i < n; i++) {
    onProgress(i + 1, n);
    const out = await PDFDocument.create();
    const [p] = await out.copyPages(src, [i]);
    out.addPage(p);
    files.push([`${base} - ${t('página {n}', { n: String(i + 1).padStart(String(n).length, '0') })}.pdf`, await out.save()]);
  }
  return zip(files);
}

// ---------- Marca de agua y números de página ----------
const winAnsi = (s) => s.replace(/[^\x20-\x7e\xa0-\xff€]/g, '?');

function hexColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Caja visible de la página y su giro, para escribir «derecho» tal como se ve. */
function geometry(page) {
  const box = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const vw = rot % 180 ? box.height : box.width, vh = rot % 180 ? box.width : box.height;
  // Punto (x, y) de la página vista (origen abajo a la izquierda) -> coordenadas del PDF
  const at = (x, y) => {
    if (rot === 90) return { x: box.x + y, y: box.y + box.height - x };
    if (rot === 180) return { x: box.x + box.width - x, y: box.y + box.height - y };
    if (rot === 270) return { x: box.x + box.width - y, y: box.y + x };
    return { x: box.x + x, y: box.y + y };
  };
  return { vw, vh, rot, at };
}

export async function marcaDeAgua(bytes, { texto, color = '#9e9e9e', opacidad = 0.25, diagonal = true }) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const txt = winAnsi(texto.trim());
  for (const page of doc.getPages()) {
    const { vw, vh, rot, at } = geometry(page);
    const ang = diagonal ? Math.atan2(vh, vw) : 0;
    const largo = diagonal ? Math.hypot(vw, vh) * 0.75 : vw * 0.8;
    let size = largo / Math.max(1, font.widthOfTextAtSize(txt, 1));
    size = Math.min(size, vh * 0.25, 160);
    const w = font.widthOfTextAtSize(txt, size);
    const h = font.heightAtSize(size) * 0.7;
    // Centro de la página vista, y el texto centrado en él
    const cx = vw / 2 - (Math.cos(ang) * w) / 2 + (Math.sin(ang) * h) / 2;
    const cy = vh / 2 - (Math.sin(ang) * w) / 2 - (Math.cos(ang) * h) / 2;
    const p = at(cx, cy);
    page.drawText(txt, { x: p.x, y: p.y, size, font, color: hexColor(color), opacity: opacidad, rotate: degrees((ang * 180) / Math.PI + rot) });
  }
  return doc.save();
}

export async function numerarPaginas(bytes, { posicion = 'abajo-centro', formato = 'n', inicio = 1, saltarPrimera = false, tamano: size = 10 }) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const total = pages.length - (saltarPrimera ? 1 : 0) + inicio - 1;
  pages.forEach((page, i) => {
    if (saltarPrimera && i === 0) return;
    const n = i + inicio - (saltarPrimera ? 1 : 0);
    const txt = winAnsi(formato === 'n-de-total' ? t('Página {n} de {total}', { n, total }) : formato === 'guiones' ? `- ${n} -` : String(n));
    const { vw, vh, rot, at } = geometry(page);
    const w = font.widthOfTextAtSize(txt, size);
    const m = Math.max(18, Math.min(vw, vh) * 0.04);
    const [v, hpos] = posicion.split('-');
    const x = hpos === 'izquierda' ? m : hpos === 'derecha' ? vw - m - w : (vw - w) / 2;
    const y = v === 'arriba' ? vh - m - size : m;
    const p = at(x, y);
    page.drawText(txt, { x: p.x, y: p.y, size, font, color: rgb(0.25, 0.25, 0.25), rotate: degrees(rot) });
  });
  return doc.save();
}

export { PDFDict };
