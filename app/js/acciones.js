// Ventanas y acciones de las herramientas del menú: comprimir, proteger y quitar la contraseña, extraer o dividir
// páginas, marca de agua, numerar páginas, notas, escanear documentos y tema de la app.
import { t } from './i18n.js';
import { state, on } from './state.js';
import { comprimir, tamano, parseRangos, extraer, dividir, marcaDeAgua, numerarPaginas } from './herramientas.js';
import { cifrar } from './cifrado.js';
import { setNoteText } from './objects.js';

const $ = (id) => document.getElementById(id);
const cap = window.Capacitor?.isNativePlatform?.() ? window.Capacitor : null;
let app = null; // funciones de app.js: makeBlob, deliverFile, reopen, toast, busy, canDownload, pickFiles, openFiles

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const base = () => state.fileName.replace(/\.pdf$/i, '');

/**
 * Ventana con un formulario. `validar(form)` devuelve un mensaje de error o null. Resuelve con el formulario al
 * aceptar, o null si se cancela.
 */
function ventana(titulo, html, { ok = t('Aceptar'), validar = () => null } = {}) {
  return new Promise((resolve) => {
    $('toolTitle').textContent = titulo;
    $('toolBody').innerHTML = html;
    $('toolOk').textContent = ok;
    $('toolStatus').textContent = '';
    $('toolStatus').classList.remove('error');
    $('toolModal').hidden = false;
    const first = $('toolBody').querySelector('input[type="text"], input[type="password"]');
    if (first && !cap) setTimeout(() => first.focus(), 50);
    const done = (v) => {
      $('toolModal').hidden = true;
      $('toolOk').onclick = $('toolCancel').onclick = $('toolClose').onclick = null;
      resolve(v);
    };
    $('toolOk').onclick = () => {
      const err = validar($('toolBody'));
      if (err) { $('toolStatus').textContent = err; $('toolStatus').classList.add('error'); return; }
      const form = $('toolBody');
      done(form);
    };
    $('toolCancel').onclick = $('toolClose').onclick = () => done(null);
  });
}
const val = (form, name) => form.querySelector(`[name="${name}"]`);
const radio = (form, name) => form.querySelector(`[name="${name}"]:checked`)?.value;

// ---------- Comprimir ----------
export async function accionComprimir() {
  const f = await ventana(t('Comprimir PDF'), `
    <p class="muted small">${esc(t('Reduce el tamaño de las fotos y escaneos del documento. El texto no cambia.'))}</p>
    <label class="choice"><input type="radio" name="nivel" value="baja"> ${esc(t('Poca: casi sin perder calidad'))}</label>
    <label class="choice"><input type="radio" name="nivel" value="media" checked> ${esc(t('Media: recomendada'))}</label>
    <label class="choice"><input type="radio" name="nivel" value="alta"> ${esc(t('Máxima: el archivo más pequeño'))}</label>`, { ok: t('Comprimir') });
  if (!f) return;
  const nivel = radio(f, 'nivel');
  if (!(await app.canDownload())) return;
  try {
    const blob = await app.makeBlob();
    app.busy(t('Comprimiendo…'));
    let r;
    try {
      r = await comprimir(new Uint8Array(await blob.arrayBuffer()), nivel, (i, n) => app.busy(t('Comprimiendo imágenes… {i} de {n}', { i, n })));
    } finally { app.busy(null); }
    if (r.despues >= r.antes * 0.97) {
      app.toast(t('Este PDF ya está optimizado: no se puede reducir más ({tam}).', { tam: tamano(r.antes) }), '', 6000);
      return;
    }
    const pct = Math.round((1 - r.despues / r.antes) * 100);
    await app.deliverFile(new Blob([r.bytes], { type: 'application/pdf' }), t('{nombre} (comprimido).pdf', { nombre: base() }),
      t('PDF comprimido'), t('De {antes} a {despues} (−{pct} %).', { antes: tamano(r.antes), despues: tamano(r.despues), pct }));
  } catch (err) {
    app.toast(t('No se pudo comprimir:') + ' ' + (err?.message || err), 'error');
  }
}

// ---------- Contraseña ----------
export async function accionProteger() {
  const f = await ventana(t('Proteger con contraseña'), `
    <p class="muted small">${esc(t('Hará falta la contraseña para abrir el PDF. Se cifra con AES de 256 bits. Si la olvidas, no se podrá recuperar.'))}</p>
    <label class="field"><span>${esc(t('Contraseña'))}</span><input type="password" name="pw" autocomplete="new-password"></label>
    <label class="field"><span>${esc(t('Repite la contraseña'))}</span><input type="password" name="pw2" autocomplete="new-password"></label>`,
  {
    ok: t('Proteger'),
    validar: (form) => {
      const a = val(form, 'pw').value, b = val(form, 'pw2').value;
      if (a.length < 4) return t('La contraseña debe tener al menos 4 caracteres.');
      if (a !== b) return t('Las contraseñas no coinciden.');
      return null;
    },
  });
  if (!f) return;
  const pw = val(f, 'pw').value;
  val(f, 'pw').value = val(f, 'pw2').value = '';
  if (!(await app.canDownload())) return;
  try {
    const blob = await app.makeBlob();
    app.busy(t('Cifrando…'));
    let bytes;
    try { bytes = await cifrar(new Uint8Array(await blob.arrayBuffer()), pw); } finally { app.busy(null); }
    await app.deliverFile(new Blob([bytes], { type: 'application/pdf' }), t('{nombre} (protegido).pdf', { nombre: base() }), t('PDF protegido'));
  } catch (err) {
    app.toast(t('No se pudo proteger:') + ' ' + (err?.message || err), 'error');
  }
}

export async function accionQuitarContrasena() {
  const protegido = [...state.sources.values()].some((s) => s.protegido);
  if (!protegido) { app.toast(t('Este PDF no tiene contraseña.')); return; }
  if (!(await app.canDownload())) return;
  try {
    const blob = await app.makeBlob();
    await app.deliverFile(blob, t('{nombre} (sin contraseña).pdf', { nombre: base() }), t('Contraseña quitada'));
  } catch (err) {
    app.toast(t('No se pudo guardar:') + ' ' + (err?.message || err), 'error');
  }
}

// ---------- Extraer o dividir ----------
export async function accionExtraer() {
  const n = state.pages.length;
  const f = await ventana(t('Extraer o dividir páginas'), `
    <label class="choice"><input type="radio" name="modo" value="extraer" checked> ${esc(t('Extraer unas páginas en un PDF nuevo'))}</label>
    <label class="field"><span>${esc(t('Páginas (por ejemplo: 1-3, 5, 8-{n})', { n }))}</span><input type="text" name="rangos" inputmode="numeric" value="1-${Math.min(n, 2)}"></label>
    <label class="choice"><input type="radio" name="modo" value="dividir"> ${esc(t('Dividir: cada página en un PDF aparte (en un .zip)'))}</label>`,
  {
    ok: t('Aceptar'),
    validar: (form) => (radio(form, 'modo') === 'extraer' && !parseRangos(val(form, 'rangos').value, n) ? t('Escribe páginas entre 1 y {n}, por ejemplo: 1-3, 5', { n }) : null),
  });
  if (!f) return;
  const modo = radio(f, 'modo');
  const rangos = val(f, 'rangos').value;
  if (!(await app.canDownload())) return;
  try {
    const blob = await app.makeBlob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (modo === 'dividir') {
      app.busy(t('Dividiendo…'));
      let z;
      try { z = await dividir(bytes, base(), (i, total) => app.busy(t('Dividiendo… página {i} de {n}', { i, n: total }))); } finally { app.busy(null); }
      await app.deliverFile(z, t('{nombre} (páginas).zip', { nombre: base() }), t('PDF dividido'));
    } else {
      const idx = parseRangos(rangos, n);
      const out = await extraer(bytes, idx);
      await app.deliverFile(new Blob([out], { type: 'application/pdf' }), t('{nombre} (páginas {p}).pdf', { nombre: base(), p: rangos.replace(/\s+/g, '') }), t('Páginas extraídas'));
    }
  } catch (err) {
    app.toast(t('No se pudo hacer:') + ' ' + (err?.message || err), 'error');
  }
}

// ---------- Marca de agua y números de página (se aplican al documento abierto) ----------
export async function accionMarcaDeAgua() {
  const f = await ventana(t('Marca de agua'), `
    <label class="field"><span>${esc(t('Texto'))}</span><input type="text" name="texto" maxlength="60" value="${esc(t('CONFIDENCIAL'))}"></label>
    <div class="row">
      <label class="field"><span>${esc(t('Color'))}</span><input type="color" name="color" value="#9e9e9e"></label>
      <label class="field"><span>${esc(t('Opacidad'))}</span><select name="op"><option value="0.15">15 %</option><option value="0.25" selected>25 %</option><option value="0.4">40 %</option><option value="0.6">60 %</option></select></label>
    </div>
    <label class="choice"><input type="checkbox" name="diag" checked> ${esc(t('En diagonal'))}</label>`,
  { ok: t('Añadir'), validar: (form) => (!val(form, 'texto').value.trim() ? t('Escribe el texto de la marca de agua.') : null) });
  if (!f) return;
  const opts = { texto: val(f, 'texto').value, color: val(f, 'color').value, opacidad: +val(f, 'op').value, diagonal: val(f, 'diag').checked };
  await aplicarAlDocumento((bytes) => marcaDeAgua(bytes, opts), t('Marca de agua añadida. Revisa el resultado y pulsa Guardar.'));
}

export async function accionNumerar() {
  const f = await ventana(t('Numerar páginas'), `
    <div class="row">
      <label class="field"><span>${esc(t('Posición'))}</span><select name="pos">
        <option value="abajo-centro">${esc(t('Abajo, en el centro'))}</option>
        <option value="abajo-derecha">${esc(t('Abajo, a la derecha'))}</option>
        <option value="abajo-izquierda">${esc(t('Abajo, a la izquierda'))}</option>
        <option value="arriba-centro">${esc(t('Arriba, en el centro'))}</option>
        <option value="arriba-derecha">${esc(t('Arriba, a la derecha'))}</option>
      </select></label>
      <label class="field"><span>${esc(t('Formato'))}</span><select name="fmt">
        <option value="n">1, 2, 3…</option>
        <option value="n-de-total">${esc(t('Página {n} de {total}', { n: 1, total: state.pages.length }))}</option>
        <option value="guiones">- 1 -</option>
      </select></label>
    </div>
    <div class="row">
      <label class="field"><span>${esc(t('Empezar en'))}</span><input type="number" name="ini" min="1" max="9999" value="1"></label>
    </div>
    <label class="choice"><input type="checkbox" name="saltar"> ${esc(t('Sin número en la primera página (portada)'))}</label>`, { ok: t('Numerar') });
  if (!f) return;
  const opts = { posicion: val(f, 'pos').value, formato: val(f, 'fmt').value, inicio: Math.max(1, +val(f, 'ini').value || 1), saltarPrimera: val(f, 'saltar').checked };
  await aplicarAlDocumento((bytes) => numerarPaginas(bytes, opts), t('Páginas numeradas. Revisa el resultado y pulsa Guardar.'));
}

async function aplicarAlDocumento(fn, aviso) {
  try {
    const blob = await app.makeBlob();
    app.busy(t('Aplicando…'));
    let bytes;
    try { bytes = await fn(new Uint8Array(await blob.arrayBuffer())); } finally { app.busy(null); }
    await app.reopen(bytes);
    app.toast(aviso, '', 5000);
  } catch (err) {
    app.toast(t('No se pudo hacer:') + ' ' + (err?.message || err), 'error');
  }
}

// ---------- Notas ----------
let notaActual = null;
function initNotas() {
  on('edit-note', ({ p, o, nueva }) => {
    notaActual = { p, o, nueva };
    $('noteText').value = o.text || '';
    $('noteModal').hidden = false;
    if (!cap) setTimeout(() => $('noteText').focus(), 50);
  });
  const cerrar = (guardar) => {
    const n = notaActual;
    notaActual = null;
    $('noteModal').hidden = true;
    if (!n) return;
    const text = $('noteText').value.trim();
    if (guardar && text) setNoteText(n.p, n.o, text);
    else if (n.nueva && !text) setNoteText(n.p, n.o, '', { borrar: true });
  };
  $('noteOk').addEventListener('click', () => cerrar(true));
  $('noteClose').addEventListener('click', () => cerrar(false));
  $('noteDelete').addEventListener('click', () => {
    const n = notaActual;
    notaActual = null;
    $('noteModal').hidden = true;
    if (n) setNoteText(n.p, n.o, '', { borrar: true });
  });
}

// ---------- Escanear ----------
export async function accionEscanear() {
  const plugin = cap?.Plugins?.Escaner;
  if (plugin) {
    try {
      const r = await plugin.escanear();
      const bin = atob(r.pdf);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const d = new Date();
      const name = t('Escaneo {fecha}.pdf', { fecha: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}` });
      await app.openFiles([new File([bytes], name, { type: 'application/pdf' })]);
      state.dirty = true;
      app.toast(t('Documento escaneado. Toca «Editar texto» para reconocer su texto, o pulsa Guardar.'), '', 6000);
    } catch (err) {
      if (/cancel/i.test(err?.message || '')) return;
      // Sin el escáner de Google (p. ej. sin Google Play Services): fotos con la cámara, convertidas a PDF
      console.warn('Escáner no disponible', err);
      const files = await app.pickFiles('image/*', true, true);
      if (files.length) await app.openFiles(files);
    }
    return;
  }
  // En el navegador: fotos de la cámara o de la galería, convertidas a PDF
  const files = await app.pickFiles('image/*', true, true);
  if (files.length) await app.openFiles(files);
}

// ---------- Tema de la app ----------
const TEMAS = ['auto', 'light', 'dark'];
function etiquetaTema(th) {
  return th === 'light' ? t('Tema: claro') : th === 'dark' ? t('Tema: oscuro') : t('Tema: automático');
}
export function cambiarTema() {
  let cur = 'auto';
  try { cur = localStorage.getItem('editorpdf.tema') || 'auto'; } catch { /* nada */ }
  const next = TEMAS[(TEMAS.indexOf(cur) + 1) % TEMAS.length];
  try { localStorage.setItem('editorpdf.tema', next); } catch { /* nada */ }
  if (next === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  $('themeLabel').textContent = etiquetaTema(next);
  app.toast(etiquetaTema(next));
}

export function initAcciones(fns) {
  app = fns;
  initNotas();
  let cur = 'auto';
  try { cur = localStorage.getItem('editorpdf.tema') || 'auto'; } catch { /* nada */ }
  $('themeLabel').textContent = etiquetaTema(cur);
}
