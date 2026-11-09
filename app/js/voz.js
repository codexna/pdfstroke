// Lectura en voz alta del documento: frase a frase, resaltando lo que se lee y siguiéndolo en pantalla.
// En la app de Android usa el motor de voz del móvil (plugin «Voz», normalmente las voces de Google; las de calidad
// alta se pueden descargar desde sus ajustes). En el navegador, las voces del sistema (en Edge, las voces naturales
// de Microsoft). Las páginas que son una imagen se reconocen antes con el OCR.
import { t } from './i18n.js';
import { state, findPage } from './state.js';
import { getLines } from './textlayer.js';
import { getEls, scrollToPoint, currentPageUid } from './viewer.js';
import { ocrAvailable, prepareOcr, recognizePage } from './ocr.js';

const cap = window.Capacitor?.isNativePlatform?.() ? window.Capacitor : null;
const native = cap?.Plugins?.Voz || null;
const $ = (id) => document.getElementById(id);
const PREF = 'editorpdf.voz';
const RATES = [0.75, 1, 1.25, 1.5, 2];

const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF)) || {}; } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem(PREF, JSON.stringify(prefs)); } catch { /* sin almacenamiento */ } };

let sentences = []; // { text, uid, rects: [{x,y,w,h}] }
let idx = 0;
let playing = false;
let session = 0; // cambia al parar: los avisos de una lectura anterior se ignoran
let lang = 'es';
let toast = () => {};
let busy = () => {};

export function initVoz(opts) {
  toast = opts.toast;
  busy = opts.busy;
  $('ttsPlay').addEventListener('click', () => (playing ? pause() : play()));
  $('ttsPrev').addEventListener('click', () => jump(-1));
  $('ttsNext').addEventListener('click', () => jump(1));
  $('ttsClose').addEventListener('click', stopReading);
  $('ttsRate').addEventListener('click', () => {
    const i = RATES.indexOf(prefs.rate ?? 1);
    prefs.rate = RATES[(i + 1) % RATES.length];
    savePrefs();
    updateBar();
    if (playing) { speakCurrent(); }
  });
  $('ttsVoice').addEventListener('click', openVoices);
  $('voiceClose').addEventListener('click', () => { $('voiceModal').hidden = true; });
  $('voiceModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('voiceModal').hidden = true; });
  $('voiceMore').addEventListener('click', () => {
    if (native) native.instalarVoces().catch(() => toast(t('No se pudieron abrir los ajustes de voz.')));
  });
  if (native) {
    native.addListener('done', ({ id }) => onDone(id));
    native.addListener('error', ({ id }) => onDone(id, true));
  }
}

// ---------- Texto del documento ----------
/** Idioma del texto (para elegir la voz): el de más palabras frecuentes. */
function detectLang(text) {
  const words = {
    es: ['el', 'la', 'de', 'que', 'y', 'en', 'los', 'del', 'las', 'por', 'con', 'una', 'para', 'es'],
    en: ['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'with', 'on', 'this', 'are', 'be', 'you'],
    pt: ['o', 'a', 'de', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'não', 'com', 'uma', 'os'],
    fr: ['le', 'la', 'de', 'et', 'les', 'des', 'du', 'un', 'une', 'est', 'pour', 'que', 'dans', 'pas'],
    de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'mit', 'den', 'ein', 'zu', 'von', 'sie', 'auf', 'für'],
    it: ['il', 'di', 'che', 'e', 'la', 'per', 'un', 'del', 'non', 'della', 'con', 'una', 'sono', 'gli'],
  };
  const toks = text.toLowerCase().split(/[^\p{L}]+/u).slice(0, 3000);
  let best = (navigator.language || 'es').slice(0, 2), bestN = 0;
  for (const [l, ws] of Object.entries(words)) {
    const set = new Set(ws);
    const n = toks.filter((w) => set.has(w)).length;
    if (n > bestN) { best = l; bestN = n; }
  }
  return best;
}

/** Frases de una página, con los recuadros de las líneas que ocupa cada una. */
async function pageSentences(p) {
  let lines = await getLines(p).catch(() => []);
  if (!lines.length && ocrAvailable()) {
    busy(t('Reconociendo el texto de la página…'));
    try { await prepareOcr(); await recognizePage(p); lines = await getLines(p); } catch { lines = []; } finally { busy(null); }
  }
  // Las líneas editadas se leen como han quedado
  const edited = new Map(p.objects.filter((o) => o.lineKey).map((o) => [o.lineKey, o]));
  const out = [];
  let cur = null;
  const flush = () => { if (cur && cur.text.trim()) out.push(cur); cur = null; };
  for (const l of lines) {
    const o = edited.get(l.key);
    const text = (o ? o.text : l.text).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const rect = o ? { x: o.x, y: o.y, w: o.w || l.w, h: (l.bottom - l.top) || o.size } : { x: l.x, y: l.top, w: l.w, h: l.bottom - l.top };
    // Las frases se cortan en el punto final; una línea puede tener el final de una y el principio de otra
    const parts = text.split(/(?<=[.!?…:;])\s+/);
    parts.forEach((part, i) => {
      if (!cur) cur = { text: '', uid: p.uid, rects: [] };
      cur.text += (cur.text && !cur.text.endsWith('-') ? ' ' : '') + part;
      if (!cur.rects.includes(rect)) cur.rects.push(rect);
      if (/[.!?…]$/.test(part) || (i < parts.length - 1)) flush();
    });
    // Una frase muy larga (o un listado sin puntos) se corta igualmente cada pocas líneas
    if (cur && cur.text.length > 280) flush();
  }
  flush();
  // Los guiones de final de línea («pala- bra») se juntan
  for (const s of out) s.text = s.text.replace(/(\p{L})- (\p{Ll})/gu, '$1$2');
  return out;
}

// ---------- Resaltado ----------
function clearHighlight() { document.querySelectorAll('.tts-hl').forEach((n) => n.remove()); }
function highlight(s) {
  clearHighlight();
  const els = getEls(s.uid);
  if (!els) return;
  for (const r of s.rects) {
    const d = document.createElement('div');
    d.className = 'tts-hl';
    Object.assign(d.style, { left: r.x - 2 + 'px', top: r.y - 1 + 'px', width: r.w + 4 + 'px', height: r.h + 2 + 'px' });
    els.objLayer.appendChild(d);
  }
  const p = findPage(s.uid);
  if (p && s.rects[0]) {
    const el = els.wrap.getBoundingClientRect();
    const viewer = document.getElementById('viewer').getBoundingClientRect();
    const y = el.top + s.rects[0].y * state.zoom;
    if (y < viewer.top + 60 || y > viewer.bottom - 140) scrollToPoint(p, s.rects[0].x, s.rects[0].y);
  }
}

// ---------- Voces ----------
async function voices() {
  if (native) {
    try { return (await native.voces()).voices.map((v) => ({ ...v, id: v.name })); } catch { return []; }
  }
  if (!('speechSynthesis' in window)) return [];
  let vs = speechSynthesis.getVoices();
  if (!vs.length) {
    await new Promise((r) => { speechSynthesis.onvoiceschanged = r; setTimeout(r, 1500); });
    vs = speechSynthesis.getVoices();
  }
  return vs.map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang, quality: /natural|neural|online|premium|enhanced/i.test(v.name) ? 400 : 300, network: !v.localService }));
}

function langName(code) {
  try { return new Intl.DisplayNames([document.documentElement.lang || 'es'], { type: 'language' }).of(code); } catch { return code; }
}

function voiceLabel(v, n) {
  const q = v.quality >= 400 ? t('calidad muy alta') : v.quality >= 300 ? t('calidad alta') : t('calidad normal');
  const friendly = native ? t('Voz {n}', { n }) : v.name.replace(/^Microsoft |^Google /, '').replace(/ Online \(Natural\)/, '');
  return `${friendly} · ${q}${v.network ? ' · ' + t('necesita internet') : ''}`;
}

async function openVoices() {
  const list = $('voiceList');
  list.innerHTML = '';
  $('voiceModal').hidden = false;
  $('voiceMore').hidden = !native;
  const all = await voices();
  const mine = all.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const show = mine.length ? mine : all;
  show.sort((a, b) => b.quality - a.quality || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  const auto = document.createElement('button');
  auto.className = 'voice-item' + (!prefs.voice ? ' on' : '');
  auto.textContent = t('Automática ({idioma})', { idioma: langName(lang) });
  auto.addEventListener('click', () => { delete prefs.voice; savePrefs(); openVoices(); preview(); });
  list.appendChild(auto);
  let n = 0, lastLang = '';
  for (const v of show) {
    if (v.lang !== lastLang) {
      const h = document.createElement('div');
      h.className = 'voice-lang';
      h.textContent = langName(v.lang) + ` (${v.lang})`;
      list.appendChild(h);
      lastLang = v.lang;
      n = 0;
    }
    const b = document.createElement('button');
    b.className = 'voice-item' + (prefs.voice === v.id ? ' on' : '');
    b.textContent = voiceLabel(v, ++n);
    b.addEventListener('click', () => { prefs.voice = v.id; prefs.voiceLang = v.lang; savePrefs(); openVoices(); preview(); });
    list.appendChild(b);
  }
  if (!show.length) list.insertAdjacentHTML('beforeend', `<p class="muted small">${t('No hay voces instaladas en este dispositivo.')}</p>`);
}

function preview() {
  const s = { text: t('Hola, así sonará la lectura de tus documentos.'), uid: null, rects: [] };
  speak(s, 'muestra');
}

// ---------- Reproducción ----------
function speak(s, id) {
  const rate = prefs.rate ?? 1;
  if (native) {
    native.hablar({ text: s.text, id, voice: prefs.voice || null, lang: prefs.voiceLang || lang, rate, pitch: 1 })
      .catch(() => onDone(id, true));
    return;
  }
  if (!('speechSynthesis' in window)) { toast(t('Este navegador no puede leer en voz alta.'), 'error'); stopReading(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(s.text);
  const v = speechSynthesis.getVoices().find((x) => x.voiceURI === prefs.voice);
  if (v) u.voice = v;
  u.lang = v?.lang || prefs.voiceLang || lang;
  u.rate = rate;
  u.onend = () => onDone(id);
  u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') onDone(id, true); };
  speechSynthesis.speak(u);
}

function speakCurrent() {
  const s = sentences[idx];
  if (!s) { finished(); return; }
  highlight(s);
  updateBar();
  speak(s, session + ':' + idx);
}

function onDone(id, error = false) {
  if (!playing || id !== session + ':' + idx) return;
  if (error && !sentences[idx]) return;
  idx++;
  if (idx >= sentences.length) { loadMore().then((more) => (more ? speakCurrent() : finished())); return; }
  speakCurrent();
}

let nextPage = 0; // índice de la siguiente página que hay que preparar
async function loadMore() {
  while (nextPage < state.pages.length) {
    const p = state.pages[nextPage++];
    const ss = await pageSentences(p);
    if (ss.length) { sentences.push(...ss); return true; }
  }
  return false;
}

function finished() {
  playing = false;
  clearHighlight();
  updateBar();
  keepAwake(false);
  toast(t('Fin del documento.'));
}

function keepAwake(on) {
  cap?.Plugins?.Lectura?.encendida({ si: on }).catch(() => {});
}

function stopSpeech() {
  session++;
  if (native) native.parar().catch(() => {});
  else if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function play() {
  if (!sentences.length) return;
  playing = true;
  keepAwake(true);
  session++;
  speakCurrent();
}

function pause() {
  playing = false;
  stopSpeech();
  keepAwake(false);
  updateBar();
}

function jump(d) {
  idx = Math.max(0, Math.min(sentences.length - 1, idx + d));
  if (playing) { stopSpeech(); speakCurrent(); } else { highlight(sentences[idx]); updateBar(); }
}

function updateBar() {
  $('ttsPlay').classList.toggle('playing', playing);
  $('ttsPlay').title = playing ? t('Pausa') : t('Leer');
  $('ttsRate').textContent = (prefs.rate ?? 1).toString().replace('.', ',') + '×';
}

/** Empieza a leer desde la página actual (o desde una página dada). */
export async function startReading(fromUid = currentPageUid()) {
  if (!state.pages.length) return;
  stopSpeech();
  const start = Math.max(0, state.pages.findIndex((p) => p.uid === fromUid));
  sentences = [];
  idx = 0;
  nextPage = start;
  busy(t('Preparando la lectura…'));
  try {
    // Al menos una página con texto (y la siguiente, para que no haya pausas)
    await loadMore();
    if (sentences.length) await loadMore();
  } finally {
    busy(null);
  }
  if (!sentences.length) {
    toast(t('No se ha encontrado texto que leer en el documento.'), '', 5000);
    return;
  }
  lang = detectLang(sentences.map((s) => s.text).join(' '));
  document.body.classList.add('tts-on');
  $('ttsBar').hidden = false;
  play();
}

export function stopReading() {
  playing = false;
  stopSpeech();
  keepAwake(false);
  clearHighlight();
  sentences = [];
  $('ttsBar').hidden = true;
  document.body.classList.remove('tts-on');
}

export const isReadingAloud = () => !$('ttsBar').hidden;
