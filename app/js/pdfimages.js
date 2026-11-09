// Imágenes del PDF original (logotipos, fotos, sellos…): dónde se dibujan en cada página y sus píxeles, para poder
// seleccionarlas con «Seleccionar» y moverlas, cambiarles el tamaño, sustituirlas o eliminarlas.
import { state } from './state.js';

const cache = new Map(); // "origen:página" -> Promise<[{ key, x, y, w, h, id, corners }]>

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

async function pdfPage(p) {
  return state.sources.get(p.src).pdf.getPage(p.index + 1);
}

/** Imágenes que dibuja una página, en coordenadas de la página tal como se ve (puntos, escala 1). */
export function pageImages(p) {
  if (p.src == null) return Promise.resolve([]);
  const k = p.src + ':' + p.index;
  if (!cache.has(k)) cache.set(k, find(p).catch((err) => { console.warn('No se pudieron localizar las imágenes', err); return []; }));
  return cache.get(k);
}

async function find(p) {
  const page = await pdfPage(p);
  const vp = page.getViewport({ scale: 1 });
  const { OPS } = pdfjsLib;
  const ol = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const out = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], args = ol.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(args, ctm);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = mul(Array.from(args[0]), ctm);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
      if (typeof args?.[0] !== 'string') continue;
      // Esquinas del cuadrado unidad (donde se dibuja la imagen) en la página vista
      const corner = (x, y) => vp.convertToViewportPoint(...apply(ctm, x, y));
      const tl = corner(0, 1), tr = corner(1, 1), bl = corner(0, 0), br = corner(1, 0);
      const xs = [tl[0], tr[0], bl[0], br[0]], ys = [tl[1], tr[1], bl[1], br[1]];
      const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
      if (w < 6 || h < 6) continue; // puntos o líneas de adorno
      // Una imagen que ocupa casi toda la página es un escaneo o un fondo, no algo que mover
      if (w * h > vp.width * vp.height * 0.8) continue;
      out.push({ id: args[0], x, y, w, h, corners: { tl, tr, bl }, key: `${args[0]}@${x.toFixed(1)},${y.toFixed(1)}` });
    }
  }
  return out;
}

/** La imagen más pequeña bajo un punto (o null). */
export async function imageAt(p, pt) {
  const imgs = await pageImages(p);
  const hits = imgs.filter((m) => pt.x >= m.x && pt.x <= m.x + m.w && pt.y >= m.y && pt.y <= m.y + m.h);
  hits.sort((a, b) => a.w * a.h - b.w * b.h);
  return hits[0] || null;
}

function objGet(page, id) {
  return new Promise((res, rej) => {
    const objs = id.startsWith('g_') ? page.commonObjs : page.objs;
    const timer = setTimeout(() => rej(new Error('Imagen no disponible')), 8000);
    try {
      objs.get(id, (v) => { clearTimeout(timer); res(v); });
    } catch (err) {
      clearTimeout(timer);
      rej(err);
    }
  });
}

/** Los píxeles de la imagen, ya orientados como se ven en la página. Devuelve { src (dataURL), mime, w, h }. */
export async function imagePixels(p, m) {
  const page = await pdfPage(p);
  const img = await objGet(page, m.id);
  if (!img) throw new Error('Imagen no disponible');
  const W = img.width, H = img.height;
  // Imagen tal cual (filas de arriba abajo)
  const raw = document.createElement('canvas');
  raw.width = W;
  raw.height = H;
  const rc = raw.getContext('2d');
  let alpha = false;
  if (img.bitmap) {
    rc.drawImage(img.bitmap, 0, 0);
    alpha = true; // no se sabe: se guarda como PNG
  } else if (img.data) {
    const id = rc.createImageData(W, H);
    const d = id.data, s = img.data;
    const n = W * H;
    if (s.length >= n * 4) { d.set(s.subarray(0, n * 4)); alpha = true; } // RGBA
    else if (s.length >= n * 3) { for (let i = 0, j = 0; i < n; i++, j += 3) { d[i * 4] = s[j]; d[i * 4 + 1] = s[j + 1]; d[i * 4 + 2] = s[j + 2]; d[i * 4 + 3] = 255; } }
    else {
      // 1 bit por píxel, en escala de grises (filas alineadas a byte)
      const row = (W + 7) >> 3;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const v = (s[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const i = (y * W + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
    }
    rc.putImageData(id, 0, 0);
  } else {
    throw new Error('Formato de imagen no soportado');
  }
  // Orientada como en la página: la esquina (0,0) de la imagen va a «tl», la (W,0) a «tr» y la (0,H) a «bl»
  const { tl, tr, bl } = m.corners;
  const scale = Math.min(Math.max(1, W / m.w, H / m.h), 2500 / Math.max(m.w, m.h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(m.w * scale));
  c.height = Math.max(1, Math.round(m.h * scale));
  const g = c.getContext('2d');
  g.setTransform(
    ((tr[0] - tl[0]) / W) * scale, ((tr[1] - tl[1]) / W) * scale,
    ((bl[0] - tl[0]) / H) * scale, ((bl[1] - tl[1]) / H) * scale,
    (tl[0] - m.x) * scale, (tl[1] - m.y) * scale,
  );
  g.imageSmoothingQuality = 'high';
  g.drawImage(raw, 0, 0);
  // Girada o inclinada: las esquinas sobrantes quedan transparentes
  const recto = (Math.abs(tr[1] - tl[1]) < 0.5 && Math.abs(bl[0] - tl[0]) < 0.5) || (Math.abs(tr[0] - tl[0]) < 0.5 && Math.abs(bl[1] - tl[1]) < 0.5);
  if (!recto) alpha = true;
  const mime = alpha ? 'image/png' : 'image/jpeg';
  return { src: c.toDataURL(mime, 0.92), mime, w: c.width, h: c.height };
}

export function dropImageCache(srcId) {
  for (const k of cache.keys()) if (k.startsWith(srcId + ':')) cache.delete(k);
}
