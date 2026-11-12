// Guías al arrastrar un objeto: líneas que avisan de que está centrado en la página o alineado con otro objeto o con
// el texto del PDF (el comienzo de las líneas, el comienzo de las palabras de la línea de encima o de debajo, la línea
// base del texto de al lado), y que lo "imantan" a esa posición cuando pasa cerca. Con Alt pulsada se mueve libremente.
// Todo va en puntos de la página sin el giro del usuario (como los objetos): la capa de las guías gira con la página.
import { state } from './state.js';
import { getEls } from './viewer.js';
import { getLines, linesSync } from './textlayer.js';
import { getBBox, rotOf, textBaseline, FONT_CSS } from './objects.js';

const SNAP_PX = { mouse: 6, pen: 8, touch: 10 }; // distancia (en la pantalla) a la que se imanta
const WORD_PX = { mouse: 3, pen: 4, touch: 5 }; // a las palabras, menos (hay muchas): si no, costaría dejarlo entre dos
const FAST = 0.6; // px/ms: moviéndose más deprisa no se imanta a las palabras (sólo al ir despacio, para colocarlo)
const NEAR_PX = 140; // texto a esta distancia (en la pantalla), como mucho
let measureCtx = null;

/** Dónde empieza cada palabra de una línea del PDF (proporcional a su ancho real). */
function wordStarts(l) {
  const text = l.text || '';
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${l.italic ? 'italic ' : ''}${l.bold ? 'bold ' : ''}100px ${FONT_CSS[l.family] || FONT_CSS.sans}`;
  const full = measureCtx.measureText(text).width;
  if (!full || !l.w) return [];
  return [...text.matchAll(/\S+/g)].map((m) => l.x + (measureCtx.measureText(text.slice(0, m.index)).width / full) * l.w);
}

/**
 * Prepara las guías para mover el objeto o de la página p. Devuelve:
 *  - snap(ev): cuánto hay que desplazar el objeto (ya movido) para que quede alineado, [dx, dy] en puntos;
 *  - draw(): dibuja las guías de lo que está alineado ahora;
 *  - end(): las quita.
 */
export function moveGuides(p, o) {
  const els = getEls(p.uid);
  const W = p.w, H = p.h;
  const layer = document.createElement('div');
  layer.className = 'guides';
  els?.selLayer.appendChild(layer);

  // Objetivos fijos: el centro de la página y los bordes y centros de los demás objetos que se ven. Cada uno lleva la
  // parte del objeto que se alinea con él (f) y su extensión (para dibujar la guía hasta él).
  const xs = [{ v: W / 2, f: 'c', center: true }];
  const ys = [{ v: H / 2, f: 'm', center: true }];
  for (const q of p.objects) {
    if (q === o || q.removed || q.type === 'note' || (q.type === 'text' && !q.text?.trim())) continue;
    const b = getBBox(q, p);
    const span = { y0: b.y, y1: b.y + b.h }, hspan = { x0: b.x, x1: b.x + b.w };
    xs.push({ v: b.x, f: 'l', ...span }, { v: b.x + b.w / 2, f: 'c', ...span }, { v: b.x + b.w, f: 'r', ...span });
    ys.push({ v: b.y, f: 't', ...hspan }, { v: b.y + b.h / 2, f: 'm', ...hspan }, { v: b.y + b.h, f: 'b', ...hspan });
    if (q.type === 'text' && !rotOf(q)) ys.push({ v: q.y + textBaseline(q.family, q.size), f: 'base', ...hspan });
  }
  // Texto del PDF (sólo en páginas sin girar: en una girada se lee de arriba abajo y no se alinea así)
  const lines = [];
  let ended = false;
  const addLines = (all) => {
    if (ended) return;
    const edited = new Set(p.objects.filter((q) => q.lineKey).map((q) => q.lineKey));
    for (const l of all) {
      if (edited.has(l.key) || l.boxes) continue; // las editadas ya son objetos; los cuadros de anotación, aparte
      lines.push(l);
      xs.push({ v: l.x, f: 'l', y0: l.top, y1: l.bottom }); // comienzo de línea: márgenes, sangrías, columnas
    }
  };
  if (!p.rotation) {
    // (con otras herramientas puede que aún no se hayan leído: entonces sirven en cuanto estén)
    const ready = linesSync(p);
    if (ready) addLines(ready);
    else getLines(p).then(addLines);
  }
  const starts = new Map(); // línea -> comienzos de sus palabras (se miden al necesitarlos)

  const feats = (b) => ({
    x: { l: b.x, c: b.x + b.w / 2, r: b.x + b.w },
    // (línea base del texto que se mueve, a partir de la caja: así vale también para la caja ya desplazada)
    y: { t: b.y, m: b.y + b.h / 2, b: b.y + b.h, base: o.type === 'text' && !rotOf(o) ? b.y + textBaseline(o.family, o.size) : null },
  });

  /** Objetivos que dependen de dónde está ahora el objeto: el comienzo de las palabras de la fila de líneas de justo
   * encima y de justo debajo, y la línea base del texto que tiene a los lados. */
  function nearTargets(b) {
    const near = NEAR_PX / state.zoom;
    const nx = [], ny = [];
    const top = b.y, bottom = b.y + b.h;
    // Filas vecinas: a menos de dos alturas de su línea (y nunca más lejos que "near")
    const reach = (l) => Math.min(near, 2 * (l.bottom - l.top));
    const ups = lines.filter((l) => l.bottom <= top + 0.5 && top - l.bottom <= reach(l));
    const downs = lines.filter((l) => l.top >= bottom - 0.5 && l.top - bottom <= reach(l));
    // La fila más cercana por cada lado (en una tabla, todas las celdas de esa fila)
    const upEdge = Math.max(...ups.map((l) => l.bottom)), downEdge = Math.min(...downs.map((l) => l.top));
    const row = (l, edge, side) => Math.abs((side ? l.top : l.bottom) - edge) <= (l.bottom - l.top) / 2;
    for (const l of [...ups.filter((l) => row(l, upEdge, 0)), ...downs.filter((l) => row(l, downEdge, 1))]) {
      if (!starts.has(l)) starts.set(l, wordStarts(l));
      for (const v of starts.get(l)) nx.push({ v, f: 'l', word: true, y0: l.top, y1: l.bottom });
    }
    for (const l of lines) {
      // Texto al lado (en la misma fila): su línea base
      const overlapY = Math.min(l.bottom, bottom) - Math.max(l.top, top);
      const gapX = Math.max(l.x - (b.x + b.w), b.x - (l.x + l.w));
      if (overlapY > 0 && gapX >= 0 && gapX <= near) ny.push({ v: l.baseline, f: 'base', x0: l.x, x1: l.x + l.w });
    }
    return { nx, ny };
  }

  // El objetivo más cercano de los que están a menos de thr (las palabras, a menos de thrWord). El centro de la
  // página manda: cuenta como si estuviera a la mitad de distancia.
  const best = (fs, list, thr, thrWord) => {
    let d = 0, score = Infinity;
    for (const t of list) {
      const f = fs[t.f];
      if (f == null) continue;
      const diff = t.v - f;
      const k = Math.abs(diff) * (t.center ? 0.5 : 1);
      if (Math.abs(diff) <= (t.word ? thrWord : thr) && k < score) { d = diff; score = k; }
    }
    return d;
  };

  let last = null, speed = 0; // velocidad del puntero (px/ms), suavizada
  const gap = (a0, a1, b0, b1) => Math.max(0, b0 - a1, a0 - b1);

  return {
    snap(ev) {
      if (ev) {
        const t = ev.timeStamp || performance.now();
        if (last && t > last.t) speed = 0.5 * speed + 0.5 * (Math.hypot(ev.clientX - last.x, ev.clientY - last.y) / (t - last.t));
        last = { x: ev.clientX, y: ev.clientY, t };
      }
      if (ev?.altKey) return [0, 0];
      const kind = ev?.pointerType in SNAP_PX ? ev.pointerType : 'mouse';
      const thr = SNAP_PX[kind] / state.zoom;
      const thrWord = speed > FAST ? -1 : WORD_PX[kind] / state.zoom;
      // Primero en vertical; luego en horizontal con la caja ya en su altura (las filas vecinas dependen de ella)
      const b = getBBox(o, p);
      const sy = best(feats(b).y, [...ys, ...nearTargets(b).ny], thr, thrWord);
      const by = { ...b, y: b.y + sy };
      const sx = best(feats(by).x, [...xs, ...nearTargets(by).nx], thr, thrWord);
      return [sx, sy];
    },
    draw() {
      const b = getBBox(o, p);
      const fs = feats(b);
      const { nx, ny } = nearTargets(b);
      const eps = 0.75 / state.zoom;
      layer.textContent = '';
      for (const [axis, list] of [['x', [...xs, ...nx]], ['y', [...ys, ...ny]]]) {
        const seen = new Map(); // de los objetivos con el mismo valor, la guía se dibuja hasta el más cercano
        for (const t of list) {
          const f = fs[axis][t.f];
          if (f == null || Math.abs(t.v - f) > eps) continue;
          const key = t.f + ':' + Math.round(t.v * 2);
          const dist = t.center ? -1 : axis === 'x' ? gap(b.y, b.y + b.h, t.y0, t.y1) : gap(b.x, b.x + b.w, t.x0, t.x1);
          if (!seen.has(key) || dist < seen.get(key).dist) seen.set(key, { t, dist });
        }
        for (const { t } of seen.values()) {
          const g = document.createElement('div');
          g.className = 'guide ' + (axis === 'x' ? 'v' : 'h') + (t.center ? ' center' : '');
          if (axis === 'x') {
            const y0 = t.center ? 0 : Math.min(b.y, t.y0), y1 = t.center ? H : Math.max(b.y + b.h, t.y1);
            Object.assign(g.style, { left: t.v + 'px', top: y0 + 'px', height: y1 - y0 + 'px' });
          } else {
            const x0 = t.center ? 0 : Math.min(b.x, t.x0), x1 = t.center ? W : Math.max(b.x + b.w, t.x1);
            Object.assign(g.style, { top: t.v + 'px', left: x0 + 'px', width: x1 - x0 + 'px' });
          }
          layer.appendChild(g);
        }
      }
    },
    end() { ended = true; layer.remove(); },
  };
}
