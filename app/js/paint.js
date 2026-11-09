// Cuentagotas y cubo de relleno: qué color se ve en un punto de la página y qué objeto hay debajo de él.
import { getEls } from './viewer.js';
import { getBBox, arrowHead } from './objects.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hex = (rgb) => '#' + rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
const rgbOf = (h) => {
  const n = parseInt((h || '#000000').slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mix = (under, over, a) => under.map((v, i) => v * (1 - a) + over[i] * a);

function distToSegment(x, y, [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((x - x1) * dx + (y - y1) * dy) / len, 0, 1) : 0;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by), d2 = s(x, y, bx, by, cx, cy), d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Parte de un objeto bajo un punto: 'fill' (su interior), 'stroke' (su borde o trazo) o null. */
function hitPart(o, x, y, p, slop = 0) {
  switch (o.type) {
    case 'rect':
    case 'highlight': {
      if (o.type === 'rect' && o.color && o.width) {
        const hw = o.width / 2 + slop;
        const near = x >= o.x - hw && x <= o.x + o.w + hw && y >= o.y - hw && y <= o.y + o.h + hw &&
          (Math.abs(x - o.x) <= hw || Math.abs(x - o.x - o.w) <= hw || Math.abs(y - o.y) <= hw || Math.abs(y - o.y - o.h) <= hw);
        if (near) return 'stroke';
      }
      return x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h ? 'fill' : null;
    }
    case 'ellipse': {
      const rx = o.w / 2, ry = o.h / 2;
      if (rx <= 0 || ry <= 0) return null;
      const d = Math.hypot((x - o.x - rx) / rx, (y - o.y - ry) / ry); // 1 = sobre el borde
      if (o.color && o.width && Math.abs(d - 1) * Math.min(rx, ry) <= o.width / 2 + slop) return 'stroke';
      return d <= 1 ? 'fill' : null;
    }
    case 'ink':
    case 'line':
    case 'arrow': {
      const pts = o.type === 'ink' ? o.points : [[o.x1, o.y1], [o.x2, o.y2]];
      const hw = (o.width || 1) / 2 + slop;
      if (pts.length === 1 && Math.hypot(x - pts[0][0], y - pts[0][1]) <= hw) return 'stroke';
      for (let i = 1; i < pts.length; i++) if (distToSegment(x, y, pts[i - 1], pts[i]) <= hw) return 'stroke';
      if (o.type === 'arrow') {
        const h = arrowHead(o);
        if (inTriangle(x, y, h.tip, h.left, h.right)) return 'stroke';
      }
      return null;
    }
    case 'text':
    case 'image': {
      const b = getBBox(o, p);
      return x >= b.x - slop && x <= b.x + b.w + slop && y >= b.y - slop && y <= b.y + b.h + slop ? 'fill' : null;
    }
  }
  return null;
}

/** Objeto que se ve en un punto de la página (el de más arriba), o null. */
export function hitObject(p, x, y, slop = 0) {
  for (let i = p.objects.length - 1; i >= 0; i--) {
    const o = p.objects[i];
    if (o.type === 'text' && !o.text?.trim()) continue; // un texto vacío (p. ej. una línea borrada) no se ve: no se pinta
    if (hitPart(o, x, y, p, slop)) return o;
  }
  return null;
}

/** Color (y transparencia) de una imagen añadida en un punto. */
function imagePixel(p, o, x, y) {
  const img = getEls(p.uid)?.objLayer.querySelector(`.obj[data-id="${o.id}"] img`);
  if (!img?.naturalWidth || !o.w || !o.h) return null;
  const u = clamp(Math.floor(((x - o.x) / o.w) * img.naturalWidth), 0, img.naturalWidth - 1);
  const v = clamp(Math.floor(((y - o.y) / o.h) * img.naturalHeight), 0, img.naturalHeight - 1);
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  try {
    ctx.drawImage(img, u, v, 1, 1, 0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return { rgb: [d[0], d[1], d[2]], a: d[3] / 255 };
  } catch {
    return null;
  }
}

/** Color que se ve en un punto de la página (en puntos): la página dibujada y, encima, los objetos añadidos. */
export function colorAt(p, x, y) {
  const els = getEls(p.uid);
  let rgb = [255, 255, 255];
  const c = els?.canvas;
  if (c?.width && els.renderedScale) {
    const px = clamp(Math.floor((x * c.width) / p.w), 0, c.width - 1);
    const py = clamp(Math.floor((y * c.height) / p.h), 0, c.height - 1);
    try {
      const d = c.getContext('2d', { willReadFrequently: true }).getImageData(px, py, 1, 1).data;
      rgb = [d[0], d[1], d[2]];
    } catch { /* lienzo no disponible: blanco */ }
  }
  // Tapas provisionales a la vista (líneas editadas cuya zona aún no se muestra modificada)
  for (const node of els?.objLayer.querySelectorAll('.cover:not([hidden])') || []) {
    const o = p.objects.find((q) => q.id === node.dataset.for);
    const l = parseFloat(node.style.left), t = parseFloat(node.style.top);
    if (o?.cover && x >= l && x <= l + parseFloat(node.style.width) && y >= t && y <= t + parseFloat(node.style.height)) {
      rgb = rgbOf(o.cover.color);
    }
  }
  // Objetos, de abajo arriba (el texto no cuenta: un toque casi nunca cae justo sobre el trazo de una letra)
  for (const o of p.objects) {
    if (o.type === 'text') continue;
    const part = hitPart(o, x, y, p);
    if (!part) continue;
    const a = o.opacity ?? 1;
    if (o.type === 'image') {
      const px = imagePixel(p, o, x, y);
      if (px) rgb = mix(rgb, px.rgb, a * px.a);
    } else if (o.type === 'highlight') {
      const hc = rgbOf(o.color); // se mezcla multiplicando (como un rotulador)
      rgb = mix(rgb, rgb.map((v, i) => (v * hc[i]) / 255), a);
    } else {
      const col = part === 'fill' ? o.fill : o.color;
      if (col) rgb = mix(rgb, rgbOf(col), a);
    }
  }
  return hex(rgb);
}
