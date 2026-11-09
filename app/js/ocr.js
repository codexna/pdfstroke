// Reconocer el texto de una página que es una imagen (una foto o un escaneo) para poder editarlo como el de un PDF
// normal. En la app de Android usa ML Kit de Google (OcrPlugin.java, generado por android-recursos/construir.py); en el
// navegador, PaddleOCR (js/ocr-web.js). En los dos casos se hace en el propio dispositivo, sin subir nada a ningún sitio.
import { state } from './state.js';
import { setOcrLines } from './textlayer.js';

const plugin = () => (window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.Ocr : null);
const enNavegador = () => !window.Capacitor?.isNativePlatform?.();
export const ocrAvailable = () => !!plugin() || (enNavegador() && typeof WebAssembly === 'object');

/** En el navegador, descarga los modelos la primera vez (tardan un poco). Devuelve true si ha hecho falta esperar. */
export async function prepareOcr() {
  if (plugin()) return false;
  const web = await import('./ocr-web.js');
  const t0 = performance.now();
  await web.preparePaddle();
  return performance.now() - t0 > 300;
}

const LADO = 2600; // píxeles del lado mayor de la imagen que se reconoce (más, más lento; menos, peores resultados)

// Letras que no suben por encima de la altura de la x, y las que bajan de la línea base: con ellas se calcula el
// tamaño de la letra y dónde está la línea base a partir de la caja de cada línea reconocida
const SOLO_X = /^[acemnorsuvwxz.,:;\-–—·•*+=~<>«»_\s]*$/;
const BAJAN = /[gjpqyQç,;()[\]{}|]/;

/** Reconoce el texto de la página. Devuelve cuántas líneas se han encontrado (ya editables). */
export async function recognizePage(p) {
  const src = state.sources.get(p.src);
  const page = await src.pdf.getPage(p.index + 1);
  const vp1 = page.getViewport({ scale: 1 }); // las mismas coordenadas que las líneas de un PDF normal
  const scale = Math.min(4, LADO / Math.max(vp1.width, vp1.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const W = canvas.width;
  let res;
  if (plugin()) {
    const image = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    canvas.width = canvas.height = 0; // libera la memoria de la imagen
    res = await plugin().recognize({ image });
  } else {
    res = await (await import('./ocr-web.js')).paddleRecognize(canvas);
    canvas.width = canvas.height = 0;
  }
  const k = vp1.width / (res.width || W); // de píxeles de la imagen a unidades de la página

  const lines = [];
  for (const l of res.lines || []) {
    const text = (l.text || '').trim();
    // El texto inclinado (p. ej. una foto torcida) no se puede editar bien: se deja como está
    if (!text || Math.abs(l.angle || 0) > 8 || l.w < 2 || l.h < 2) continue;
    const h = l.h * k;
    const asc = !SOLO_X.test(text);
    const desc = BAJAN.test(text);
    const size = Math.min(300, Math.max(4, h / ((asc ? 0.72 : 0.52) + (desc ? 0.21 : 0))));
    const baseline = (l.y + l.h) * k - (desc ? 0.21 * size : 0);
    // Una fila con huecos grandes (columnas de una tabla, un formulario) se separa en trozos, como en un PDF normal
    const words = (l.words || []).filter((w) => w.text?.trim()).sort((a, b) => a.x - b.x);
    const parts = [];
    for (const w of words.length ? words : [{ ...l, text }]) {
      const last = parts[parts.length - 1];
      if (last && (w.x - last.right) * k <= size * 1.5) {
        last.text += ' ' + w.text;
        last.right = Math.max(last.right, w.x + w.w);
        last.top = Math.min(last.top, w.y);
        last.bottom = Math.max(last.bottom, w.y + w.h);
      } else {
        parts.push({ text: w.text, x: w.x, right: w.x + w.w, top: w.y, bottom: w.y + w.h });
      }
    }
    for (const s of parts) {
      lines.push({
        key: 'O' + lines.length, ocr: true, text: s.text, runs: [{ text: s.text, family: 'sans', bold: false, italic: false }],
        family: 'sans', bold: false, italic: false,
        x: s.x * k, w: (s.right - s.x) * k, baseline, size: Math.round(size * 100) / 100,
        top: Math.min(s.top, l.y) * k, bottom: Math.max(s.bottom, l.y + l.h) * k,
      });
    }
  }
  setOcrLines(p, lines);
  return lines.length;
}
