// Convertir a Word: crea un .docx con el texto del PDF (ya con las ediciones), página a página. El texto se agrupa en
// párrafos con su tamaño, negrita, cursiva, sangría y separación; las columnas de una misma fila van separadas por
// tabuladores. Las páginas sin texto (escaneos) se añaden como imagen. Todo en el dispositivo.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // caracteres de control que Word no admite
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const twips = (pt) => Math.round(pt * 20);
const EMU = 12700; // por punto

function fontOf(page, name) {
  let n = '';
  try { if (page.commonObjs.has(name)) n = page.commonObjs.get(name).name || ''; } catch { /* sin datos de la fuente */ }
  n = n.replace(/^[A-Z]{6}\+/, '');
  const family = /courier|mono|consol/i.test(n) ? 'Courier New'
    : !/sans|arial|helv|calibri|verdana|tahoma|segoe/i.test(n) && /times|serif|roman|georgia|garamond|cambria|book/i.test(n)
      ? 'Times New Roman' : /calibri/i.test(n) ? 'Calibri' : 'Arial';
  return { family, bold: /bold|black|heavy|semibold|demi/i.test(n), italic: /italic|oblique/i.test(n) };
}

/** Líneas de una página: trozos de texto con la misma línea base, ordenados de izquierda a derecha. */
async function pageLines(page) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  try { await page.getOperatorList(); } catch { /* sólo para saber las fuentes */ }
  const items = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str.length) continue;
    const t = pdfjsLib.Util.transform(vp.transform, it.transform);
    if (t[0] <= 0 || Math.abs(t[1]) > 0.02 * t[0]) continue; // sólo texto horizontal
    const size = Math.hypot(t[2], t[3]);
    if (size < 1) continue;
    items.push({ str: it.str, x: t[4], y: t[5], w: it.width * vp.scale, size, font: fontOf(page, it.fontName) });
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const l = lines[lines.length - 1];
    if (l && Math.abs(it.y - l.y) <= 0.35 * Math.min(it.size, l.size)) l.items.push(it);
    else lines.push({ y: it.y, size: it.size, items: [it] });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.x = l.items[0].x;
    l.size = Math.max(...l.items.map((i) => i.size));
    l.right = Math.max(...l.items.map((i) => i.x + i.w));
  }
  return { lines: lines.filter((l) => l.items.some((i) => i.str.trim())), w: vp.width, h: vp.height };
}

/** Tramos de una línea: los trozos con huecos grandes van separados por un tabulador (columnas de una tabla). */
function lineRuns(line) {
  const runs = [];
  let prev = null;
  for (const it of line.items) {
    let sep = '';
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      if (gap > it.size * 1.5) sep = '\t';
      else if (gap > it.size * 0.15 && !/\s$/.test(prev.str) && !/^\s/.test(it.str)) sep = ' ';
    }
    runs.push({ text: sep + it.str, size: it.size, ...it.font });
    prev = it;
  }
  return runs;
}

/** Párrafos: líneas seguidas con la misma sangría, el mismo tamaño y poco espacio entre ellas. */
function paragraphs(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    const tabbed = lineRuns(l).some((r) => r.text.startsWith('\t'));
    const gap = cur ? l.y - cur.lastY : 0;
    const joins = cur && !tabbed && !cur.tabbed && Math.abs(l.x - cur.x) < l.size && Math.abs(l.size - cur.size) < 0.5 &&
      gap > 0 && gap < l.size * 1.6;
    if (joins) {
      const last = cur.runs[cur.runs.length - 1];
      // Una palabra partida con guion al final de la línea se vuelve a unir
      if (/[a-záéíóúñü]-$/i.test(last.text)) last.text = last.text.slice(0, -1);
      else cur.runs.push({ ...last, text: ' ' });
      cur.runs.push(...lineRuns(l));
      cur.lastY = l.y;
      cur.right = Math.max(cur.right, l.right);
    } else {
      cur = { x: l.x, size: l.size, firstY: l.y, lastY: l.y, right: l.right, tabbed, runs: lineRuns(l), gapBefore: gap };
      out.push(cur);
    }
  }
  return out;
}

function runXml(r) {
  const props = `<w:rFonts w:ascii="${r.family}" w:hAnsi="${r.family}" w:cs="${r.family}"/>` +
    (r.bold ? '<w:b/>' : '') + (r.italic ? '<w:i/>' : '') + `<w:sz w:val="${Math.max(2, Math.round(r.size * 2))}"/>`;
  return r.text.split('\t').map((t, i) =>
    (i ? `<w:r><w:rPr>${props}</w:rPr><w:tab/></w:r>` : '') + (t ? `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>` : ''),
  ).join('');
}

// ---------- .docx (un zip) ----------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Crea un .zip con [nombre, datos] (los nombres en UTF-8). */
export async function zip(files, type = 'application/zip') {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let off = 0;
  for (const [name, data] of files) {
    const raw = typeof data === 'string' ? enc.encode(data) : data;
    const packed = await deflate(raw);
    const method = packed && packed.length < raw.length ? 8 : 0;
    const body = method ? packed : raw;
    const nm = enc.encode(name), crc = crc32(raw);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x800, true); head.setUint16(8, method, true);
    head.setUint32(14, crc, true); head.setUint32(18, body.length, true); head.setUint32(22, raw.length, true);
    head.setUint16(26, nm.length, true);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x800, true); cen.setUint16(10, method, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, body.length, true); cen.setUint32(24, raw.length, true);
    cen.setUint16(28, nm.length, true); cen.setUint32(42, off, true);
    parts.push(new Uint8Array(head.buffer), nm, body);
    central.push(new Uint8Array(cen.buffer), nm);
    off += 30 + nm.length + body.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type });
}

/** Imagen JPEG de una página (para las que no tienen texto). */
async function pageImage(page) {
  const vp = page.getViewport({ scale: 150 / 72 });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Convierte un PDF (bytes) en un documento de Word (.docx). onProgress(i, n) informa de la página que se procesa.
 */
export async function pdfToDocx(bytes, onProgress) {
  const pdf = await pdfjsLib.getDocument({
    data: bytes, cMapUrl: 'vendor/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/standard_fonts/',
  }).promise;
  const body = [], images = [];
  let pgW = 595, pgH = 842;
  const margin = 36; // 1,27 cm: casi todo el texto del PDF cabe con su sangría
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.(i, pdf.numPages);
      const page = await pdf.getPage(i);
      const { lines, w, h } = await pageLines(page);
      if (i === 1) { pgW = w; pgH = h; }
      if (i > 1) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      if (!lines.length) {
        // Página sin texto (un escaneo, un dibujo): como imagen, al ancho útil
        const jpg = await pageImage(page);
        const id = 'rIdImg' + i;
        images.push([`word/media/pagina${i}.jpg`, jpg, id]);
        const cw = (pgW - margin * 2) * EMU, ch = Math.round(cw * (h / w));
        body.push(`<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${Math.round(cw)}" cy="${ch}"/>` +
          `<wp:docPr id="${i}" name="Página ${i}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
          '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
          `<pic:nvPicPr><pic:cNvPr id="${i}" name="pagina${i}.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/>` +
          `<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(cw)}" cy="${ch}"/></a:xfrm>` +
          '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>');
        continue;
      }
      let prevBottom = margin;
      for (const p of paragraphs(lines)) {
        const top = p.firstY - p.size;
        const before = Math.max(0, Math.min(72, top - prevBottom));
        prevBottom = p.lastY + p.size * 0.3;
        const indent = Math.max(0, p.x - margin);
        // Centrado si su texto queda en medio de la página
        const center = Math.abs((p.x + p.right) / 2 - w / 2) < w * 0.04 && p.x > w * 0.15;
        body.push(`<w:p><w:pPr><w:spacing w:before="${twips(before)}" w:after="0" w:line="${twips(p.size * 1.15)}" w:lineRule="atLeast"/>` +
          (center ? '<w:jc w:val="center"/>' : `<w:ind w:left="${twips(indent)}"/>`) + `</w:pPr>${p.runs.map(runXml).join('')}</w:p>`);
      }
    }
  } finally {
    pdf.destroy();
  }
  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>' + body.join('') +
    `<w:sectPr><w:pgSz w:w="${twips(pgW)}" w:h="${twips(pgH)}"${pgW > pgH ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${twips(margin)}" w:right="${twips(margin)}" w:bottom="${twips(margin)}" w:left="${twips(margin)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    images.map(([path, , id]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${path.slice(5)}"/>`).join('') +
    '</Relationships>';
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="jpg" ContentType="image/jpeg"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', doc],
    ['word/_rels/document.xml.rels', rels],
    ...images.map(([path, data]) => [path, data]),
  ], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}
