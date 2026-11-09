// OCR en el navegador (versión web y PC) con PaddleOCR PP-OCRv5: detector «mobile» + reconocedor del alfabeto latino
// (español, inglés, portugués, francés, alemán, italiano y otros 26 idiomas), sobre ONNX Runtime Web. Todo se ejecuta
// en el propio navegador: la imagen no sale del dispositivo. Los modelos (unos 13 MB) y el motor (15 MB) están en
// ocr-web/ y se descargan la primera vez que se usa; luego los guarda la caché del navegador.
// Devuelve lo mismo que el plugin nativo de Android (OcrPlugin.java): { width, height, lines: [{ text, x, y, w, h }] }.

const BASE = new URL('../ocr-web/', import.meta.url).href;
const DET_LADO = 1600; // lado mayor de la imagen que ve el detector (múltiplo de 32 al redimensionar)
const DET_UMBRAL = 0.3; // probabilidad mínima de que un píxel sea texto
const CAJA_UMBRAL = 0.55; // puntuación media mínima de una caja de texto
const UNCLIP = 1.6; // cuánto se agranda cada zona detectada para leerla (el detector marca el «núcleo» del texto)
const UNCLIP_TINTA = 0.75; // y para medirla: así la caja se ajusta a la tinta y el tamaño de letra sale bien
const REC_ALTO = 48; // alto de la imagen de cada línea para el reconocedor (PP-OCRv5)
const REC_CONF = 0.5; // confianza mínima de una línea reconocida

let listo = null;

function cargarScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
}

async function iniciar() {
  if (!window.ort) await cargarScript(BASE + 'ort.wasm.min.js');
  const ort = window.ort;
  ort.env.wasm.wasmPaths = BASE;
  ort.env.logLevel = 'error'; // sin los avisos internos del motor
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
  const [det, rec, dict] = await Promise.all([
    ort.InferenceSession.create(BASE + 'det.onnx', opts),
    ort.InferenceSession.create(BASE + 'rec-latin.onnx', opts),
    fetch(BASE + 'dict-latin.txt').then((r) => r.text()),
  ]);
  const letras = dict.replace(/\r/g, '').split('\n');
  if (letras[letras.length - 1] === '') letras.pop();
  return { ort, det, rec, chars: ['', ...letras, ' '] }; // 0 = «en blanco» (CTC); al final, el espacio
}

/** ¿Puede este navegador hacer OCR? (WebAssembly y lienzos) */
export const paddleAvailable = () => typeof WebAssembly === 'object';

/** Descarga y prepara los modelos (si no lo están ya). Útil para mostrar «descargando…» la primera vez. */
export function preparePaddle() {
  listo ||= iniciar().catch((err) => { listo = null; throw err; });
  return listo;
}

// ---------- Detección (DB) ----------
function tensorDeteccion(ort, src, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const n = w * h;
  const data = new Float32Array(3 * n);
  // Como en PaddleOCR (imagen BGR de OpenCV con la media y la desviación de ImageNet)
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < n; i++) {
    const b = px[i * 4 + 2] / 255, gg = px[i * 4 + 1] / 255, r = px[i * 4] / 255;
    data[i] = (b - mean[0]) / std[0];
    data[n + i] = (gg - mean[1]) / std[1];
    data[2 * n + i] = (r - mean[2]) / std[2];
  }
  return new ort.Tensor('float32', data, [1, 3, h, w]);
}

/** Zonas de texto (rectángulos en píxeles de la imagen original) a partir del mapa de probabilidad. */
function cajas(prob, w, h, sx, sy, W, H) {
  const marca = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (prob[i] > DET_UMBRAL) marca[i] = 1;
  const out = [];
  const cola = new Int32Array(w * h);
  for (let i0 = 0; i0 < w * h; i0++) {
    if (marca[i0] !== 1) continue;
    let ini = 0, fin = 0, suma = 0, n = 0;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    cola[fin++] = i0;
    marca[i0] = 2;
    while (ini < fin) {
      const i = cola[ini++];
      const x = i % w, y = (i - x) / w;
      suma += prob[i];
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && marca[i - 1] === 1) { marca[i - 1] = 2; cola[fin++] = i - 1; }
      if (x < w - 1 && marca[i + 1] === 1) { marca[i + 1] = 2; cola[fin++] = i + 1; }
      if (y > 0 && marca[i - w] === 1) { marca[i - w] = 2; cola[fin++] = i - w; }
      if (y < h - 1 && marca[i + w] === 1) { marca[i + w] = 2; cola[fin++] = i + w; }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (n < 8 || bh < 2 || suma / n < CAJA_UMBRAL) continue;
    // Se agranda la zona como hace PaddleOCR (distancia = área × ratio / perímetro)
    const caja = (ratio) => {
      const d = (bw * bh * ratio) / (2 * (bw + bh));
      const rx0 = Math.max(0, (x0 - d) * sx), ry0 = Math.max(0, (y0 - d) * sy);
      const rx1 = Math.min(W, (x1 + 1 + d) * sx), ry1 = Math.min(H, (y1 + 1 + d) * sy);
      return { x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0 };
    };
    out.push({ ...caja(UNCLIP), tinta: caja(UNCLIP_TINTA) });
  }
  // De arriba abajo y, en la misma fila, de izquierda a derecha
  return out.sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) / 2 ? a.x - b.x : a.y - b.y));
}

// ---------- Reconocimiento (CTC) ----------
async function reconocer(ort, rec, chars, src, c) {
  const w = Math.max(16, Math.min(3200, Math.round((REC_ALTO * c.w) / c.h)));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = REC_ALTO;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, c.x, c.y, c.w, c.h, 0, 0, w, REC_ALTO);
  const px = g.getImageData(0, 0, w, REC_ALTO).data;
  const n = w * REC_ALTO;
  const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    data[i] = px[i * 4 + 2] / 127.5 - 1; // B
    data[n + i] = px[i * 4 + 1] / 127.5 - 1; // G
    data[2 * n + i] = px[i * 4] / 127.5 - 1; // R
  }
  const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, REC_ALTO, w]) });
  const t = out[rec.outputNames[0]];
  const [, pasos, clases] = t.dims;
  const p = t.data;
  let texto = '', prev = 0, suma = 0, n2 = 0;
  for (let s = 0; s < pasos; s++) {
    let best = 0, bv = -Infinity;
    for (let k = 0; k < clases; k++) {
      const v = p[s * clases + k];
      if (v > bv) { bv = v; best = k; }
    }
    if (best !== 0 && best !== prev && best < chars.length) {
      texto += chars[best];
      suma += bv;
      n2++;
    }
    prev = best;
  }
  return { texto: texto.trim(), conf: n2 ? suma / n2 : 0 };
}

/** Reconoce el texto de un lienzo (la página ya dibujada). */
export async function paddleRecognize(src) {
  const { ort, det, rec, chars } = await preparePaddle();
  const W = src.width, H = src.height;
  const f = Math.min(1, DET_LADO / Math.max(W, H));
  const w = Math.max(32, Math.round((W * f) / 32) * 32), h = Math.max(32, Math.round((H * f) / 32) * 32);
  const salida = await det.run({ [det.inputNames[0]]: tensorDeteccion(ort, src, w, h) });
  const prob = salida[det.outputNames[0]].data;
  const lines = [];
  for (const c of cajas(prob, w, h, W / w, H / h, W, H)) {
    if (c.w < 4 || c.h < 4) continue;
    const { texto, conf } = await reconocer(ort, rec, chars, src, c);
    if (texto && conf >= REC_CONF) lines.push({ text: texto, ...c.tinta });
  }
  return { width: W, height: H, lines };
}
