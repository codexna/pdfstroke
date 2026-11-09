// Punto de entrada: abrir/guardar documentos, barra de herramientas, propiedades, atajos y PWA.
import { t } from './i18n.js';
import { state, on, emit, uid, undo, redo, canUndo, canRedo, resetHistory, setDefaultStyle } from './state.js';
import { buildPages, fitWidth, setZoom, scheduleRender, scrollToPoint, getEls, viewerEl, updateCurrentPage } from './viewer.js';
import {
  renderObjects, renderSelection, applyStyle, deleteSelected, duplicateSelected, nudgeSelected, addImage,
  selectedObject, deselect, finishEditing, isDrawTool, isEditingText, justTyped, resumeEditing, toggleTextStyle, textStyleState,
  textSelectionStyle, stepTextSize, resetTextBox, syncEditing, commitPendingStyle, discardPendingStyle,
  startColorPick, cancelColorPick, isPickingColor, paintObject,
} from './objects.js';
import { dropSource } from './preview.js';
import { pdfToDocx, zip } from './word.js';
import { docxToPdf } from './docx.js';
import { imagesToPdf, pdfToImages } from './convert.js';
import { canDownload, adBeforeDownload, countDownload, startMonetization, showPro } from './pro.js';
import { invalidateTextBoxes, searchDocument } from './textlayer.js';
import { ocrAvailable, prepareOcr, recognizePage } from './ocr.js';
import { buildPdf, replacedChars, flattenedFields } from './exporter.js';
import { renderThumbs, addBlankPage, insertPagesAfterCurrent, blankPage } from './thumbs.js';
import { askSignature } from './signature.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const $ = (id) => document.getElementById(id);
const body = document.body;

// ---------- Avisos ----------
function toast(msg, kind = '', ms = 3200) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 500);
}

/**
 * App de Android: primero el anuncio (versión gratuita) y, cuando se cierra, se guarda el archivo y se avisa en grande.
 * saveFn guarda y devuelve { title, where } (o null si se entregó con el menú de compartir).
 */
async function deliver(saveFn) {
  await adBeforeDownload();
  const done = await saveFn();
  const left = countDownload();
  if (done) showSaved(done, left);
  else if (left) toast(left, '', 5000);
}

function showSaved({ title, where }, left) {
  $('savedTitle').textContent = title;
  $('savedWhere').textContent = where;
  $('savedLeft').textContent = left;
  $('savedLeft').hidden = !left;
  $('savedModal').hidden = false;
}
$('savedOk').addEventListener('click', () => { $('savedModal').hidden = true; });
$('savedModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('savedModal').hidden = true; });
const inDocs = (name) => t('Documentos › PDF Stroke › {nombre}', { nombre: name });

// Mientras se guarda (y se ve el anuncio) no se puede pulsar otra vez: contaría dos descargas
let downloading = false;
const oneAtATime = (fn) => async (...args) => {
  if (downloading) return;
  downloading = true;
  try { return await fn(...args); } finally { downloading = false; }
};
on('toast', (m) => (typeof m === 'string' ? toast(m) : toast(m.msg, m.kind, m.ms)));

function busy(text) {
  $('busyText').textContent = text || '';
  $('busy').hidden = !text;
}

// ---------- Abrir documentos ----------
async function loadSource(name, bytes) {
  const task = pdfjsLib.getDocument({
    data: bytes.slice(), // pdf.js transfiere el buffer al worker; guardamos el original para pdf-lib
    cMapUrl: 'vendor/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'vendor/standard_fonts/',
  });
  task.onPassword = (update, reason) => {
    const pw = prompt(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? t('Contraseña incorrecta. Inténtalo de nuevo:') : t('"{nombre}" está protegido. Introduce la contraseña:', { nombre: name }));
    if (pw == null) task.destroy(); else update(pw);
  };
  const pdf = await task.promise;
  const src = { id: uid('s'), name, bytes, pdf };
  state.sources.set(src.id, src);
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    pages.push({
      uid: uid('p'), src: src.id, index: i - 1, w: vp.width, h: vp.height,
      view: [...page.view], baseRotate: page.rotate, rotation: 0, objects: [],
    });
    if (i % 20 === 0) busy(t('Cargando páginas… {i} / {n}', { i, n: pdf.numPages }));
  }
  return pages;
}

async function readFile(file) {
  return new Uint8Array(await file.arrayBuffer());
}

function confirmDiscard() {
  return !state.dirty || confirm(t('Hay cambios sin guardar. ¿Descartarlos y abrir otro documento?'));
}

// Tipos de archivo que se pueden abrir: PDF, imágenes (se convierten a PDF) y Word .docx (se convierte a PDF)
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const isPdfFile = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImageFile = (f) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name);
const isDocxFile = (f) => f.type === DOCX_MIME || /\.docx$/i.test(f.name);
const baseName = (name) => name.replace(/\.[^.]+$/, '') || 'documento';
const ACCEPT = { pdf: 'application/pdf,.pdf', image: 'image/*', word: DOCX_MIME + ',.docx' };
ACCEPT.all = [ACCEPT.pdf, ACCEPT.image, ACCEPT.word].join(',');

/** Convierte los archivos (en orden) en páginas. Las imágenes seguidas van en un mismo PDF. */
async function filesToPages(files) {
  const pages = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (isPdfFile(f)) {
      if (files.length > 1) busy(t('Uniendo archivos… {i} de {n}', { i: i + 1, n: files.length }));
      pages.push(...(await loadSource(f.name, await readFile(f))));
    } else if (isImageFile(f)) {
      const group = [f];
      while (i + 1 < files.length && isImageFile(files[i + 1])) group.push(files[++i]);
      const bytes = await imagesToPdf(group, (k, n) => busy(n > 1 ? t('Convirtiendo imágenes a PDF… {k} de {n}', { k, n }) : t('Convirtiendo la imagen a PDF…')));
      pages.push(...(await loadSource(baseName(group[0].name) + '.pdf', bytes)));
    } else if (isDocxFile(f)) {
      busy(t('Convirtiendo Word a PDF…'));
      const bytes = await docxToPdf(await readFile(f));
      pages.push(...(await loadSource(baseName(f.name) + '.pdf', bytes)));
    } else if (/\.(doc|odt|rtf|pages)$/i.test(f.name)) {
      throw new Error(t('"{nombre}": solo se pueden convertir documentos de Word .docx. Ábrelo en Word y guárdalo como .docx.', { nombre: f.name }));
    } else {
      throw new Error(t('"{nombre}" no es un PDF, una imagen ni un documento de Word (.docx).', { nombre: f.name }));
    }
  }
  return pages;
}

/** Abre uno o varios archivos como documento nuevo (varios = se unen en uno). Devuelve true si se ha abierto. */
async function openFiles(files, handle = null) {
  deselect(); // la edición en curso pertenece al documento anterior
  if (!files.length || !confirmDiscard()) return false;
  busy(files.length > 1 ? t('Uniendo archivos…') : t('Abriendo…'));
  try {
    const pages = await filesToPages(files);
    if (!pages.length) return false;
    const single = files.length === 1;
    const converted = !(single && isPdfFile(files[0]));
    const name = (single ? baseName(files[0].name) : t('{nombre} (unido)', { nombre: baseName(files[0].name) })) + '.pdf';
    startDocument(pages, name, converted ? null : handle);
    if (converted) {
      state.dirty = true; // todavía no está guardado
      if (!single) {
        toast(t('Se han unido {n} archivos ({p} páginas). Ordénalas en el panel Páginas y pulsa Guardar.', { n: files.length, p: pages.length }));
        toggleSidebar(true);
      } else {
        toast(isDocxFile(files[0])
          ? t('Word convertido a PDF. Revisa el resultado y pulsa Guardar.')
          : t('Imagen convertida a PDF. Pulsa Guardar para guardarlo.'));
      }
    }
    return true;
  } catch (err) {
    console.error(err);
    if (err?.name !== 'PasswordException') toast(t('No se pudo abrir:') + ' ' + (err?.message || err), 'error');
    return false;
  } finally {
    busy(null);
  }
}
const openDocument = (file, handle = null) => openFiles([file], handle);

function startDocument(pages, name, handle) {
  deselect();
  for (const [id, s] of state.sources) {
    if (!pages.some((p) => p.src === id)) { s.pdf.destroy?.(); state.sources.delete(id); dropSource(id); }
  }
  state.pages = pages;
  state.fileName = name || t('documento') + '.pdf';
  state.fileHandle = handle;
  state.selection = null;
  resetHistory();
  discardPendingStyle();
  body.classList.remove('no-doc');
  $('fileName').textContent = state.fileName;
  document.title = state.fileName + ' · PDF Stroke';
  $('pages').innerHTML = '';
  buildPages();
  renderThumbs();
  fitWidth(viewerEl.clientWidth < 700 ? 3 : 1.25);
  viewerEl.scrollTo(0, 0);
  setTool('select');
}

function newBlankDocument() {
  deselect();
  if (!confirmDiscard()) return;
  startDocument([blankPage()], t('documento') + '.pdf', null);
}

async function insertPdfFiles(files) {
  deselect();
  busy(t('Añadiendo páginas…'));
  try {
    const all = await filesToPages(files);
    if (all.length) {
      insertPagesAfterCurrent(all);
      toast(all.length === 1 ? t('Se ha añadido 1 página.') : t('Se han añadido {n} páginas.', { n: all.length }));
    }
  } catch (err) {
    console.error(err);
    toast(t('No se pudieron añadir las páginas:') + ' ' + (err?.message || err), 'error');
  } finally {
    busy(null);
  }
}

async function pickAndOpen() {
  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{
          description: t('PDF, imágenes y Word'),
          accept: { 'application/pdf': ['.pdf'], 'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'], [DOCX_MIME]: ['.docx'] },
        }],
      });
      const files = await Promise.all(handles.map((h) => h.getFile()));
      return openFiles(files, handles.length === 1 ? handles[0] : null);
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  $('fileOpen').click();
}

/** Abre el selector de archivos con los tipos indicados y devuelve los elegidos (o [] si se cancela). */
function pickFiles(accept, multiple) {
  return new Promise((resolve) => {
    const input = $('fileTool');
    input.accept = accept;
    input.multiple = multiple;
    input.value = '';
    let settled = false;
    const finish = (files) => { if (!settled) { settled = true; resolve(files); } };
    input.addEventListener('change', () => finish([...input.files]), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    input.click();
  });
}

$('fileOpen').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) openFiles(fs); });
$('fileInsert').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) insertPdfFiles(fs); });
$('fileImage').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) insertImageFile(f); });

// ---------- Imágenes ----------
function loadImage(src) {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = src; });
}
const fileToDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });

async function createAsset(dataUrl, mime) {
  const img = await loadImage(dataUrl);
  let w = img.naturalWidth, h = img.naturalHeight;
  const MAX = 2400;
  if (mime !== 'image/png' && mime !== 'image/jpeg' || Math.max(w, h) > MAX) {
    const k = Math.min(1, MAX / Math.max(w, h));
    w = Math.round(w * k); h = Math.round(h * k);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    mime = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    dataUrl = c.toDataURL(mime, 0.92);
  }
  const id = uid('a');
  state.assets[id] = { src: dataUrl, mime, w, h };
  return id;
}

async function insertImageFile(file) {
  try {
    const id = await createAsset(await fileToDataUrl(file), file.type);
    setTool('select');
    addImage(id);
  } catch (err) {
    console.error(err);
    toast(t('No se pudo cargar la imagen.'), 'error');
  }
}

async function insertSignature() {
  const src = await askSignature();
  if (!src) return;
  const id = await createAsset(src, 'image/png');
  setTool('select');
  addImage(id, { signature: true });
}

// ---------- Guardar y compartir ----------
async function makeBlob() {
  commitPendingStyle();
  syncEditing();
  busy(t('Generando PDF…'));
  try {
    const bytes = await buildPdf();
    if (replacedChars) {
      toast(t('Aviso: {n} carácter(es) no admitidos por las fuentes del PDF (p. ej. flechas o emojis) se han guardado como "?".', { n: replacedChars }));
    }
    if (flattenedFields) {
      toast(flattenedFields === 1
        ? t('Aviso: un campo de formulario que tenía algo encima ha pasado a formar parte de la página (ya no se puede rellenar).')
        : t('Aviso: {n} campos de formulario que tenían algo encima han pasado a formar parte de la página (ya no se pueden rellenar).', { n: flattenedFields }));
    }
    return new Blob([bytes], { type: 'application/pdf' });
  } finally {
    busy(null);
  }
}

// ---------- App de Android (Capacitor): guardar en Documentos y compartir con el menú de Android ----------
const native = window.Capacitor?.isNativePlatform?.() ? window.Capacitor : null;

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

/** Escribe el PDF en un archivo del móvil y devuelve su dirección (uri). */
async function writeNative(blob, name, directory) {
  const { Filesystem } = native.Plugins;
  const path = directory === 'DOCUMENTS' ? 'PDF Stroke/' + name : name;
  const r = await Filesystem.writeFile({ path, data: await blobToBase64(blob), directory, recursive: true });
  return r.uri;
}

/**
 * Guarda en Documentos › PDF Stroke y devuelve el nombre con el que ha quedado. Android no deja sobrescribir un
 * archivo que creó otra app (o una instalación anterior de esta): entonces se guarda como «nombre (2).pdf», etc.
 */
async function saveToDocuments(blob, name) {
  const slash = name.lastIndexOf('/') + 1;
  const dot = name.lastIndexOf('.');
  const ext = dot > slash ? name.slice(dot) : '';
  const base = ext ? name.slice(0, dot) : name;
  let lastErr;
  for (let i = 1; i <= 50; i++) {
    const n = i === 1 ? name : `${base} (${i})${ext}`;
    try {
      await writeNative(blob, n, 'DOCUMENTS');
      return n.slice(slash);
    } catch (err) {
      lastErr = err;
      if (!/EACCES|denied|EEXIST|exists/i.test(err?.message || '')) break;
    }
  }
  throw lastErr;
}

async function shareNative(blob, name) {
  const uri = await writeNative(blob, name, 'CACHE');
  await native.Plugins.Share.share({ title: name, files: [uri], dialogTitle: 'Compartir' });
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function writeToHandle(handle, blob) {
  if ((await handle.queryPermission?.({ mode: 'readwrite' })) !== 'granted' &&
      (await handle.requestPermission?.({ mode: 'readwrite' })) !== 'granted') throw new Error('Permiso denegado');
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
}

async function saveImpl() {
  if (!state.pages.length) return;
  if (native) {
    // Versión gratuita: límite de descargas al día y, antes de guardar, un anuncio
    if (!(await canDownload())) return;
    try {
      const blob = await makeBlob();
      await deliver(async () => {
        try {
          const saved = await saveToDocuments(blob, state.fileName);
          state.dirty = false;
          return { title: t('Archivo guardado'), where: inDocs(saved) };
        } catch (err) {
          // Si no se puede escribir en Documentos, se ofrece guardarlo donde se quiera con el menú de compartir
          console.warn('No se pudo guardar en Documentos', err);
          await shareNative(blob, state.fileName);
          state.dirty = false;
          return null;
        }
      });
    } catch (err) {
      if (!/cancel/i.test(err?.message || '')) toast(t('Error al guardar:') + ' ' + (err?.message || err), 'error');
    }
    return;
  }
  try {
    let handle = state.fileHandle;
    // El selector debe abrirse antes de generar el PDF, mientras el clic del usuario sigue "activo"
    if (!handle?.createWritable && window.showSaveFilePicker) {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: state.fileName,
          types: [{ description: t('Documento PDF'), accept: { 'application/pdf': ['.pdf'] } }],
        });
      } catch (err) {
        if (err?.name === 'AbortError') return;
        handle = null;
      }
    }
    const blob = await makeBlob();
    if (handle?.createWritable) {
      try {
        await writeToHandle(handle, blob);
        state.fileHandle = handle;
        state.fileName = handle.name;
        $('fileName').textContent = handle.name;
        state.dirty = false;
        toast(t('Guardado ✓'));
        return;
      } catch (err) {
        console.warn('No se pudo escribir en el archivo, se descargará', err);
      }
    }
    download(blob, state.fileName);
    state.dirty = false;
    toast(t('PDF descargado ✓'));
  } catch (err) {
    console.error(err);
    toast(t('Error al guardar:') + ' ' + (err?.message || err), 'error');
  }
}

async function shareImpl() {
  try {
    if (native && !(await canDownload())) return;
    const blob = await makeBlob();
    if (native) { await deliver(async () => { await shareNative(blob, state.fileName); return null; }); return; }
    const file = new File([blob], state.fileName, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: state.fileName });
    else download(blob, state.fileName);
  } catch (err) {
    if (err?.name !== 'AbortError' && !/cancel/i.test(err?.message || '')) toast(t('No se pudo compartir:') + ' ' + (err?.message || err), 'error');
  }
}
const save = oneAtATime(saveImpl);
const share = oneAtATime(shareImpl);

if (native || navigator.canShare?.({ files: [new File([''], 'a.pdf', { type: 'application/pdf' })] })) $('btnShare').hidden = false;

const convertToWord = oneAtATime(() => convertToWordImpl());
const convertToImages = oneAtATime((format) => convertToImagesImpl(format));

// ---------- Convertir a Word ----------
async function convertToWordImpl() {
  if (!state.pages.length || !(await canDownload())) return;
  try {
    const pdf = await makeBlob(); // con todo lo editado
    busy(t('Convirtiendo a Word…'));
    let docx;
    try {
      docx = await pdfToDocx(new Uint8Array(await pdf.arrayBuffer()), (i, n) => busy(t('Convirtiendo a Word… página {i} de {n}', { i, n })));
    } finally {
      busy(null);
    }
    const name = state.fileName.replace(/\.pdf$/i, '') + '.docx';
    if (native) {
      await deliver(async () => {
        try {
          return { title: t('Documento de Word guardado'), where: inDocs(await saveToDocuments(docx, name)) };
        } catch (err) {
          console.warn('No se pudo guardar en Documentos', err);
          await shareNative(docx, name);
          return null;
        }
      });
    } else {
      download(docx, name);
      toast(t('Documento de Word descargado ✓'), '', 5000);
    }
  } catch (err) {
    console.error(err);
    if (!/cancel/i.test(err?.message || '')) toast(t('No se pudo convertir a Word:') + ' ' + (err?.message || err), 'error');
  }
}

// ---------- Convertir a imagen ----------
async function zipImages(named) {
  const files = [];
  for (const x of named) files.push([x.name, new Uint8Array(await x.blob.arrayBuffer())]);
  return zip(files);
}

async function convertToImagesImpl(format = 'jpg') {
  if (!state.pages.length || !(await canDownload())) return;
  try {
    const pdf = await makeBlob(); // con todo lo editado
    busy(t('Convirtiendo a imagen…'));
    let imgs;
    try {
      imgs = await pdfToImages(new Uint8Array(await pdf.arrayBuffer()), format, (i, n) => busy(t('Convirtiendo a imagen… página {i} de {n}', { i, n })));
    } finally {
      busy(null);
    }
    const base = baseName(state.fileName);
    const one = imgs.length === 1;
    const digits = String(imgs.length).length;
    const named = imgs.map((x) => ({ blob: x.blob, name: one ? `${base}.${format}` : `${base}-${String(x.page).padStart(digits, '0')}.${format}` }));
    if (native) {
      await deliver(async () => {
        try {
          let saved = '';
          for (const x of named) saved = await saveToDocuments(x.blob, one ? x.name : `${base}/${x.name}`);
          return one ? { title: t('Imagen guardada'), where: inDocs(saved) }
            : { title: t('{n} imágenes guardadas', { n: named.length }), where: inDocs(base) };
        } catch (err) {
          console.warn('No se pudo guardar en Documentos', err);
          if (one) await shareNative(named[0].blob, named[0].name);
          else await shareNative(await zipImages(named), t('{nombre} (imágenes).zip', { nombre: base }));
          return null;
        }
      });
    } else if (one) {
      download(named[0].blob, named[0].name);
      toast(t('Imagen descargada ✓'), '', 5000);
    } else {
      busy(t('Preparando el archivo .zip…'));
      try { download(await zipImages(named), t('{nombre} (imágenes).zip', { nombre: base })); } finally { busy(null); }
      toast(t('{n} imágenes descargadas en un archivo .zip ✓', { n: named.length }), '', 5000);
    }
  } catch (err) {
    console.error(err);
    if (!/cancel/i.test(err?.message || '')) toast(t('No se pudo convertir a imagen:') + ' ' + (err?.message || err), 'error');
  }
}

// ---------- Menú Convertir ----------
const convertMenu = $('convertMenu');
function closeConvertMenu() { convertMenu.hidden = true; }
$('btnConvert').addEventListener('mousedown', (e) => e.preventDefault());
$('btnConvert').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!convertMenu.hidden) { closeConvertMenu(); return; }
  const r = $('btnConvert').getBoundingClientRect();
  convertMenu.hidden = false;
  const w = convertMenu.offsetWidth;
  convertMenu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
  convertMenu.style.top = r.bottom + 6 + 'px';
});
convertMenu.addEventListener('mousedown', (e) => e.preventDefault());
convertMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-conv]');
  if (!b) return;
  closeConvertMenu();
  const c = b.dataset.conv;
  if (c === 'word') convertToWord();
  else if (c === 'jpg' || c === 'png') convertToImages(c);
  else if (c === 'merge') $('fileInsert').click();
});
document.addEventListener('click', (e) => { if (!convertMenu.hidden && !convertMenu.contains(e.target)) closeConvertMenu(); });
window.addEventListener('resize', closeConvertMenu);

// ---------- Accesos directos de la pantalla de inicio ----------
document.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', async () => {
  const act = b.dataset.start;
  if (act === 'merge') {
    const files = await pickFiles(ACCEPT.all, true);
    if (files.length === 1) toast(t('Para unir, elige dos o más archivos. También puedes añadir más después desde el panel Páginas.'));
    if (files.length) await openFiles(files);
  } else if (act === 'img2pdf') {
    const files = await pickFiles(ACCEPT.image, true);
    if (files.length) await openFiles(files);
  } else if (act === 'word2pdf') {
    const files = await pickFiles(ACCEPT.word, false);
    if (files.length) await openFiles(files);
  } else if (act === 'pdf2word' || act === 'pdf2img') {
    const files = await pickFiles(ACCEPT.pdf, false);
    if (files.length && await openFiles(files)) {
      if (act === 'pdf2word') convertToWord(); else convertToImages('jpg');
    }
  } else if (act === 'pages') {
    const files = await pickFiles(ACCEPT.pdf, false);
    if (files.length && await openFiles(files)) toggleSidebar(true);
  }
}));

// ---------- Páginas que son una imagen: reconocer su texto (OCR, sólo en la app de Android) ----------
let recognizing = false;
const noTextFound = new Set(); // páginas en las que el OCR no encontró nada (no se repite a cada toque)
on('image-page', async (p) => {
  const key = p.src + ':' + p.index;
  if (!ocrAvailable()) {
    toast(t('Esta página es una imagen y no tiene texto que editar. Usa «Añadir texto» para escribir encima, o «Tapar» y luego «Añadir texto» para cambiar lo que pone.'), '', 6000);
    return;
  }
  if (recognizing) return;
  if (noTextFound.has(key)) { toast(t('No se ha encontrado texto en esta página.'), '', 4000); return; }
  recognizing = true;
  try {
    busy(t('Preparando el reconocimiento de texto… (solo la primera vez)'));
    await prepareOcr();
    busy(t('Reconociendo el texto de la página…'));
    const n = await recognizePage(p);
    if (n) {
      toast(t('Texto reconocido ✓ Toca una línea para editarla.'), '', 5000);
    } else {
      noTextFound.add(key);
      toast(t('No se ha encontrado texto en esta página.'), '', 4000);
    }
  } catch (err) {
    console.error(err);
    toast(t('No se pudo reconocer el texto:') + ' ' + (err?.message || err), 'error', 6000);
  } finally {
    busy(null);
    recognizing = false;
  }
});

// ---------- Herramientas ----------
const HINTS = {
  select: t('Toca un texto o un objeto para seleccionarlo y moverlo.'),
  edittext: t('Toca una línea del documento para editar su texto.'),
  text: t('Toca donde quieras escribir.'),
  pen: t('Dibuja a mano alzada. Con dos dedos te desplazas y haces zoom.'),
  highlight: t('Arrastra sobre una zona o toca una línea de texto para resaltarla.'),
  rect: t('Arrastra para dibujar un rectángulo (Mayús = cuadrado).'),
  ellipse: t('Arrastra para dibujar una elipse (Mayús = círculo).'),
  line: t('Arrastra para dibujar una línea (Mayús = ángulos de 45°).'),
  arrow: t('Arrastra para dibujar una flecha (Mayús = ángulos de 45°).'),
  whiteout: t('Arrastra para tapar contenido con un rectángulo del color elegido.'),
  picker: t('Toca la página para tomar el color de ese punto.'),
};

let toolBeforePick = 'select';

function setTool(tool) {
  if (tool === 'image') { $('fileImage').click(); return; }
  if (tool === 'sign') { insertSignature(); return; }
  stopPicking();
  if (tool !== state.tool) {
    if (tool === 'picker') toolBeforePick = state.tool;
    if (tool !== 'select') deselect();
    else finishEditing();
  }
  state.tool = tool;
  body.className = body.className.replace(/\btool-\S+/g, '').trim() + ' tool-' + tool;
  body.classList.toggle('draw-mode', isDrawTool(tool));
  document.querySelectorAll('#toolbar [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  renderSelection();
  updateProps();
  emit('tool');
  if (tool === 'picker') startColorPick(usePickedColor);
}

/**
 * Cuentagotas de la barra de herramientas: como en Paint, el color tomado pasa a ser "el color" de las herramientas
 * (Rellenar, Dibujar, Tapar y las formas) y se vuelve a la herramienta de antes.
 */
function usePickedColor(color) {
  for (const prop of ['bucket', 'stroke', 'fill', 'whiteout']) setDefaultStyle(prop, color);
  toast(t('Color elegido:') + ' ' + color.toUpperCase());
  setTool(toolBeforePick === 'picker' ? 'select' : toolBeforePick);
}

/** Cuentagotas junto a un selector de color: el color tomado se aplica sólo a esa propiedad. */
function pickInto(prop, color) {
  const sel = selectedObject();
  const o = sel?.o;
  if (prop === 'fill' && o && !o.whiteout && (o.type === 'rect' || o.type === 'ellipse') && !o.fill) {
    setDefaultStyle('fill', color);
    paintObject(sel.p, o, color); // una forma sin relleno pasa a tenerlo
  } else {
    applyStyle(styleTarget(prop), color);
  }
  updateProps();
  resumeEditing();
}

function stopPicking() {
  if (isPickingColor()) cancelColorPick();
  document.querySelectorAll('#props .pick.on').forEach((b) => b.classList.remove('on'));
}

$('toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (b) setTool(b.dataset.tool);
});

// ---------- Barra de propiedades ----------
const TEXT_PROPS = ['family', 'size', 'bold', 'italic', 'textColor'];
const STROKE_PROPS = ['stroke', 'width', 'opacity'];
const TOOL_PROPS = {
  select: [], edittext: [], text: TEXT_PROPS, pen: STROKE_PROPS, highlight: ['hlcolor'],
  rect: [...STROKE_PROPS, 'fill'], ellipse: [...STROKE_PROPS, 'fill'], line: STROKE_PROPS, arrow: STROKE_PROPS, whiteout: ['fill'],
  picker: [], fill: ['bucket'],
};
const OBJ_PROPS = {
  text: TEXT_PROPS, ink: STROKE_PROPS, line: STROKE_PROPS, arrow: STROKE_PROPS,
  rect: [...STROKE_PROPS, 'fill'], ellipse: [...STROKE_PROPS, 'fill'], highlight: ['hlcolor'], image: ['opacity'],
};

function updateProps() {
  const sel = selectedObject();
  const s = state.style;
  let props, v;
  if (sel) {
    const o = sel.o;
    props = o.whiteout ? ['fill'] : [...(OBJ_PROPS[o.type] || [])];
    if (o.type === 'text' && (o.w != null || o.h != null)) props.push('autofit');
    props.push('selected');
    v = {
      family: o.family, size: o.size, bold: o.bold, italic: o.italic, textColor: o.color,
      stroke: o.color || s.stroke, width: o.width, opacity: o.opacity ?? 1,
      fill: o.fill || s.fill, fillOn: !!o.fill, hlcolor: o.color, bucket: s.bucket,
    };
  } else {
    props = TOOL_PROPS[state.tool] || [];
    v = { ...s };
  }
  const whiteout = sel ? !!sel.o.whiteout : state.tool === 'whiteout';
  if (whiteout) v.fill = sel ? sel.o.fill : s.whiteout;
  // Si aparece "Ajustar caja" (primer control), la barra vuelve al principio para que se vea
  const autofitHidden = $('pAutofit').hidden;
  document.querySelectorAll('#props [data-prop]').forEach((n) => { n.hidden = !props.includes(n.dataset.prop); });
  if (autofitHidden && !$('pAutofit').hidden) $('props').scrollLeft = 0;
  $('pFillOn').hidden = whiteout;
  $('props').classList.toggle('whiteout', whiteout);
  $('toolHint').hidden = props.length > 0;
  $('toolHint').textContent = HINTS[state.tool] || '';
  // En un texto, fuente, color, negrita y cursiva reflejan la parte seleccionada
  const ts = sel?.o.type === 'text' ? textSelectionStyle() : null;
  if (ts) Object.assign(v, { bold: ts.bold, italic: ts.italic, family: ts.family || v.family, textColor: ts.color || v.textColor });
  if (v.family) $('pFamily').value = v.family;
  if (v.size) $('pSize').value = Math.round(v.size * 100) / 100;
  $('pBold').classList.toggle('on', !!v.bold);
  $('pItalic').classList.toggle('on', !!v.italic);
  if (v.textColor) $('pTextColor').value = v.textColor;
  if (v.stroke) $('pStroke').value = v.stroke;
  if (v.fill) $('pFill').value = v.fill;
  $('pFillOn').checked = !!v.fillOn;
  if (v.width != null) { $('pWidth').value = v.width; $('pWidthNum').value = v.width; }
  if (v.bucket) $('pBucket').value = v.bucket;
  $('pOpacity').value = v.opacity ?? 1;
  document.querySelectorAll('#pHlColors [data-c]').forEach((b) => b.classList.toggle('on', b.dataset.c === v.hlcolor));
}
on('selection', updateProps);

const styleTarget = (prop) => (prop === 'fill' && state.tool === 'whiteout' && !selectedObject() ? 'whiteout' : prop);
function bindInput(id, prop, parse = (x) => x) {
  const el = $(id);
  // Un valor no válido (p. ej. el campo vacío mientras se escribe) no se aplica
  el.addEventListener('input', () => { const v = parse(el.value); if (v != null) applyStyle(styleTarget(prop), v, false); });
  // Al terminar de elegir el valor se muestra el valor aplicado y se vuelve al texto que se estaba editando
  el.addEventListener('change', () => {
    const v = parse(el.value);
    if (v != null) applyStyle(styleTarget(prop), v, true);
    else commitPendingStyle();
    updateProps();
    resumeEditing();
  });
}

/**
 * Botones de formato que no quitan el foco al texto en edición. En pantallas táctiles sólo cuenta un toque:
 * si el dedo se desliza (para desplazar la barra), no se aplica nada.
 */
function bindPress(el, fn) {
  let start = null;
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('touchstart', (e) => { const t = e.touches[0]; start = { x: t.clientX, y: t.clientY }; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const tap = start && Math.hypot(t.clientX - start.x, t.clientY - start.y) < 10 &&
      el.contains(document.elementFromPoint(t.clientX, t.clientY));
    start = null;
    if (!tap || !e.cancelable) return;
    e.preventDefault(); // sin clic simulado ni cambio de foco
    fn();
  });
  el.addEventListener('click', fn);
}
bindInput('pSize', 'size', (x) => { const v = parseFloat(x); return Number.isFinite(v) ? Math.min(200, Math.max(3, v)) : null; });
bindInput('pTextColor', 'textColor');
bindInput('pStroke', 'stroke');
bindInput('pFill', 'fill');
bindInput('pWidth', 'width', parseFloat);
bindInput('pWidthNum', 'width', (x) => { const v = parseFloat(x); return Number.isFinite(v) && v > 0 ? Math.min(100, Math.max(0.5, v)) : null; });
bindInput('pBucket', 'bucket');
// El deslizador y la casilla del grosor muestran siempre el mismo valor
$('pWidth').addEventListener('input', () => { $('pWidthNum').value = $('pWidth').value; });
$('pWidthNum').addEventListener('input', () => { const v = parseFloat($('pWidthNum').value); if (v > 0) $('pWidth').value = v; });
// Cuentagotas de cada color: el siguiente toque en la página toma el color (otro toque en el botón lo cancela)
for (const b of document.querySelectorAll('#props .pick')) {
  bindPress(b, () => {
    const was = b.classList.contains('on');
    stopPicking();
    if (was) return;
    b.classList.add('on');
    startColorPick((color) => { b.classList.remove('on'); pickInto(b.dataset.pick, color); });
  });
}
bindInput('pOpacity', 'opacity', parseFloat);
$('pFamily').addEventListener('change', (e) => { applyStyle('family', e.target.value); updateProps(); resumeEditing(); });
$('pFillOn').addEventListener('change', (e) => applyStyle('fillOn', e.target.checked));
bindPress($('pBold'), () => { toggleTextStyle('bold'); updateProps(); });
bindPress($('pItalic'), () => { toggleTextStyle('italic'); updateProps(); });
bindPress($('pSizeDown'), () => { stepTextSize(-1); updateProps(); });
bindPress($('pSizeUp'), () => { stepTextSize(1); updateProps(); });
bindPress($('pAutofit'), () => { resetTextBox(); updateProps(); });
// Mientras se escribe, la barra refleja el estilo del texto seleccionado
document.addEventListener('selectionchange', () => {
  if (!isEditingText()) return;
  const ts = textSelectionStyle();
  if (!ts) return;
  $('pBold').classList.toggle('on', ts.bold);
  $('pItalic').classList.toggle('on', ts.italic);
  if (ts.family && document.activeElement !== $('pFamily')) $('pFamily').value = ts.family;
  if (ts.color && document.activeElement !== $('pTextColor')) $('pTextColor').value = ts.color;
});
// Pulsar en una zona de la barra que no es un control (etiquetas, huecos) no debe terminar la edición del texto
$('props').addEventListener('mousedown', (e) => { if (!e.target.closest('input, select, button')) e.preventDefault(); });
$('props').addEventListener('keydown', (e) => {
  const t = e.target;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (key === 'escape') { stopPicking(); resumeEditing(); return; }
  // Intro en el campo de tamaño (aunque no cambie el valor) vuelve al texto
  if (key === 'enter' && t.id === 'pSize') { setTimeout(resumeEditing, 0); return; }
  // Deshacer/rehacer desde un control de la barra usa el historial de la aplicación
  if (mod && (key === 'z' || key === 'y')) {
    e.preventDefault();
    e.stopPropagation();
    if (key === 'y' || e.shiftKey) doRedo(); else doUndo();
    return;
  }
  // Tras abrir la lista de fuentes o el selector de color sin cambiar nada, al escribir (o borrar) se vuelve al texto
  const editKey = e.key.length === 1 || key === 'backspace' || key === 'delete';
  if (!mod && editKey && (t.tagName === 'SELECT' || t.type === 'color')) resumeEditing();
  else if (!mod && key.startsWith('arrow') && t.type === 'color') resumeEditing();
});
// Pulsar el nombre junto a un selector de color lo abre siempre (el navegador no lo hace si hay texto seleccionado)
$('props').addEventListener('click', (e) => {
  const label = e.target.closest('label.color');
  if (!label || e.target.closest('input, button')) return;
  e.preventDefault();
  label.querySelector('input[type="color"]')?.click();
});
// Doble clic en un tirador: la caja de texto vuelve a ajustarse a su contenido
viewerEl.addEventListener('dblclick', (e) => { if (e.target.closest('.handle')) resetTextBox(); });
$('pHlColors').addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]');
  if (b) { applyStyle('hlcolor', b.dataset.c); updateProps(); }
});
$('pDelete').addEventListener('click', deleteSelected);
$('pDuplicate').addEventListener('click', duplicateSelected);

// ---------- Historial y estructura ----------
on('history', () => {
  $('btnUndo').disabled = !canUndo();
  $('btnRedo').disabled = !canRedo();
});
on('restore', ({ structural }) => {
  if (structural) { buildPages(); renderThumbs(); }
  else state.pages.forEach(renderObjects);
  state.pages.forEach(invalidateTextBoxes);
  renderSelection();
  updateProps();
});
on('pages', () => {
  buildPages();
  renderThumbs();
  updateProps();
});

function doUndo() { commitPendingStyle(); finishEditing(); undo(); }
function doRedo() { commitPendingStyle(); finishEditing(); redo(); }

// ---------- Zoom e indicador de página ----------
on('zoom', () => { $('btnZoomFit').textContent = Math.round(state.zoom * 100) + '%'; });
on('currentpage', (cur) => {
  const i = state.pages.findIndex((p) => p.uid === cur);
  $('pageIndicator').textContent = i >= 0 ? `${i + 1} / ${state.pages.length}` : '';
});
on('pages', updateCurrentPage);

// ---------- Búsqueda ----------
let hits = [], hitIndex = -1, searchSeq = 0;
function clearHits() { document.querySelectorAll('.search-hit').forEach((n) => n.remove()); }
function showHit(i) {
  clearHits();
  if (!hits.length) return;
  hitIndex = (i + hits.length) % hits.length;
  const h = hits[hitIndex];
  const p = state.pages.find((q) => q.uid === h.uid);
  const els = getEls(h.uid);
  if (!p || !els) return;
  const d = document.createElement('div');
  d.className = 'search-hit';
  Object.assign(d.style, { left: h.x - 1 + 'px', top: h.y - 1 + 'px', width: h.w + 2 + 'px', height: h.h + 2 + 'px' });
  els.inner.appendChild(d);
  scrollToPoint(p, h.x, h.y);
  $('searchCount').textContent = t('{i} de {n}', { i: hitIndex + 1, n: hits.length });
}
async function runSearch() {
  const q = $('searchInput').value;
  const seq = ++searchSeq;
  clearHits();
  if (!q.trim()) { hits = []; $('searchCount').textContent = ''; return; }
  $('searchCount').textContent = t('Buscando…');
  const res = await searchDocument(q);
  if (seq !== searchSeq) return;
  hits = res;
  if (!hits.length) $('searchCount').textContent = t('Sin resultados');
  else showHit(0);
}
function openSearch() {
  $('searchPanel').hidden = false;
  $('searchInput').focus();
  $('searchInput').select();
}
function closeSearch() {
  $('searchPanel').hidden = true;
  clearHits();
}
let searchTimer = 0;
$('searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 300); });
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (hits.length) showHit(hitIndex + (e.shiftKey ? -1 : 1)); else runSearch(); }
  if (e.key === 'Escape') closeSearch();
});
$('searchNext').addEventListener('click', () => showHit(hitIndex + 1));
$('searchPrev').addEventListener('click', () => showHit(hitIndex - 1));
$('searchClose').addEventListener('click', closeSearch);
on('pages', () => { hits = []; clearHits(); $('searchCount').textContent = ''; });

// ---------- Panel lateral ----------
function toggleSidebar(open = !body.classList.contains('sidebar-open')) {
  body.classList.toggle('sidebar-open', open);
  setTimeout(() => { scheduleRender(50); }, 260);
}
$('btnPages').addEventListener('click', () => toggleSidebar());
$('btnCloseSidebar').addEventListener('click', () => toggleSidebar(false));
$('scrim').addEventListener('click', () => toggleSidebar(false));
on('thumbnav', () => { if (window.innerWidth < 760) toggleSidebar(false); });
if (window.innerWidth >= 900) body.classList.add('sidebar-open');

// ---------- Botones ----------
$('btnOpen').addEventListener('click', pickAndOpen);
$('btnOpenBig').addEventListener('click', pickAndOpen);
$('btnNewBlank').addEventListener('click', newBlankDocument);
$('btnSave').addEventListener('click', save);
// Guardar o compartir no quitan el foco al texto que se está escribiendo
for (const id of ['btnSave', 'btnShare']) $(id).addEventListener('mousedown', (e) => e.preventDefault());
$('btnShare').addEventListener('click', share);
$('btnPro').addEventListener('click', () => showPro());
$('btnUndo').addEventListener('click', doUndo);
$('btnRedo').addEventListener('click', doRedo);
$('btnZoomIn').addEventListener('click', () => setZoom(state.zoom * 1.2));
$('btnZoomOut').addEventListener('click', () => setZoom(state.zoom / 1.2));
$('btnZoomFit').addEventListener('click', () => fitWidth(4));
$('btnSearch').addEventListener('click', () => ($('searchPanel').hidden ? openSearch() : closeSearch()));
$('btnAddBlank').addEventListener('click', addBlankPage);
$('btnInsertPdf').addEventListener('click', () => $('fileInsert').click());

// ---------- Teclado ----------
const isTyping = (t) => t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
const KEY_TOOLS = {
  v: 'select', e: 'edittext', t: 'text', p: 'pen', h: 'highlight', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', w: 'whiteout',
  i: 'picker', g: 'fill',
};

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 's') { e.preventDefault(); if (state.pages.length) save(); return; }
  if (mod && k === 'o') { e.preventDefault(); pickAndOpen(); return; }
  if (mod && k === 'f') { e.preventDefault(); if (state.pages.length) openSearch(); return; }
  if (isTyping(e.target) || !state.pages.length || !$('signModal').hidden) return;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if (mod && k === 'y') { e.preventDefault(); doRedo(); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (mod && (k === '+' || k === '=')) { e.preventDefault(); setZoom(state.zoom * 1.2); return; }
  if (mod && k === '-') { e.preventDefault(); setZoom(state.zoom / 1.2); return; }
  if (mod && k === '0') { e.preventDefault(); fitWidth(4); return; }
  if (mod || e.altKey) return;
  if (k === 'delete' || k === 'backspace') { if (state.selection) { e.preventDefault(); deleteSelected(); } return; }
  if (k === 'escape') {
    if (isPickingColor()) { stopPicking(); if (state.tool === 'picker') setTool(toolBeforePick); return; }
    if (state.selection) deselect(); else setTool('select');
    return;
  }
  const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
  if (arrows[k] && state.selection) {
    e.preventDefault();
    const n = e.shiftKey ? 10 : 1;
    nudgeSelected(arrows[k][0] * n, arrows[k][1] * n);
    return;
  }
  // Justo después de escribir, una letra suelta probablemente iba para el texto: no cambia de herramienta
  if (KEY_TOOLS[k] && !justTyped()) setTool(KEY_TOOLS[k]);
});

// Pegar imágenes desde el portapapeles
document.addEventListener('paste', (e) => {
  if (isTyping(e.target) || !state.pages.length) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); insertImageFile(item.getAsFile()); }
});

// ---------- Arrastrar y soltar archivos ----------
window.addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  body.classList.add('dragging-file');
});
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) body.classList.remove('dragging-file'); });
window.addEventListener('drop', async (e) => {
  body.classList.remove('dragging-file');
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  const docs = files.filter((f) => isPdfFile(f) || isDocxFile(f));
  const imgs = files.filter(isImageFile);
  if (!state.pages.length) {
    const ok = files.filter((f) => isPdfFile(f) || isDocxFile(f) || isImageFile(f));
    if (ok.length) openFiles(ok);
  } else if (docs.length) {
    if (confirm(t('¿Añadir las páginas al documento actual?\n(Cancelar = abrirlo como documento nuevo)'))) insertPdfFiles(docs);
    else openFiles(docs);
  } else if (imgs.length) {
    for (const f of imgs) await insertImageFile(f);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- PWA: service worker, "Abrir con" (escritorio) y "Compartir con" (Android) ----------
// (en la app de Android todo va ya dentro de la app: no hace falta el service worker)
if (!native && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker no registrado', err));
}

if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    const handle = params.files?.[0];
    if (handle) openDocument(await handle.getFile(), handle);
  });
}

(async () => {
  const qs = new URLSearchParams(location.search);
  if (!qs.has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('editorpdf-shared');
    const res = await cache.match('shared-file');
    if (!res) return;
    const blob = await res.blob();
    const name = decodeURIComponent(res.headers.get('X-File-Name') || t('compartido') + '.pdf');
    await cache.delete('shared-file');
    openDocument(new File([blob], name, { type: 'application/pdf' }));
  } catch (err) {
    console.error(err);
  }
})();

setTool('select');
startMonetization();
