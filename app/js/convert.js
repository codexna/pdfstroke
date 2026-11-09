import { t } from './i18n.js';
// Conversiones con imágenes: imágenes → PDF (una página por imagen) y PDF → imágenes (una imagen por página).

const A4 = [595.28, 841.89];

/** Decodifica una imagen respetando la orientación de la foto (EXIF). */
async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } catch {
      throw new Error(t('No se puede leer la imagen "{nombre}" (formato no admitido).', { nombre: file.name }));
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}

const toBlob = (canvas, type, q) => new Promise((res, rej) =>
  canvas.toBlob((b) => (b ? res(b) : rej(new Error(t('No hay memoria suficiente para crear la imagen.')))), type, q));

/**
 * Crea un PDF con una página A4 por imagen (vertical u horizontal según la imagen), con la imagen centrada y lo
 * más grande posible. Las PNG conservan la transparencia; el resto se guarda en JPEG.
 */
export async function imagesToPdf(files, onProgress) {
  const { PDFDocument } = PDFLib;
  const pdf = await PDFDocument.create();
  for (const [i, f] of files.entries()) {
    onProgress?.(i + 1, files.length);
    const bmp = await decode(f);
    const w0 = bmp.width, h0 = bmp.height;
    const k = Math.min(1, 3000 / Math.max(w0, h0)); // suficiente para imprimir A4 a más de 250 ppp
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * k));
    c.height = Math.max(1, Math.round(h0 * k));
    const ctx = c.getContext('2d');
    const png = /png/i.test(f.type) || /\.png$/i.test(f.name);
    if (!png) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await toBlob(c, png ? 'image/png' : 'image/jpeg', 0.9);
    const data = new Uint8Array(await blob.arrayBuffer());
    const img = png ? await pdf.embedPng(data) : await pdf.embedJpg(data);
    const [pw, ph] = w0 > h0 ? [A4[1], A4[0]] : A4;
    const s = Math.min(pw / w0, ph / h0);
    const page = pdf.addPage([pw, ph]);
    page.drawImage(img, { x: (pw - w0 * s) / 2, y: (ph - h0 * s) / 2, width: w0 * s, height: h0 * s });
  }
  return pdf.save();
}

/**
 * Convierte cada página de un PDF en una imagen. format: 'jpg' | 'png'. Devuelve [{ blob, page }].
 * Resolución: 200 ppp (sin pasar de 4000 píxeles de lado).
 */
export async function pdfToImages(bytes, format, onProgress) {
  const pdf = await pdfjsLib.getDocument({
    data: bytes, cMapUrl: 'vendor/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/standard_fonts/',
  }).promise;
  const out = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.(i, pdf.numPages);
      const page = await pdf.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(200 / 72, 4000 / Math.max(vp1.width, vp1.height));
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      out.push({ page: i, blob: await toBlob(c, format === 'png' ? 'image/png' : 'image/jpeg', 0.92) });
      c.width = c.height = 0; // libera la memoria del lienzo
      page.cleanup();
    }
  } finally {
    pdf.destroy();
  }
  return out;
}
