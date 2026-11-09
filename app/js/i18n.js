// Idioma de la app: el del móvil (o del navegador). Los textos originales están en español y son la clave de cada
// traducción (js/lang/<idioma>.js). Si el idioma del móvil no está traducido, la app sale en inglés.
// Para probar otro idioma: ?lang=fr en la dirección, o localStorage 'editorpdf.idioma' = 'fr'.
export const IDIOMAS = ['es', 'en', 'pt', 'fr', 'de', 'it'];

function elegir() {
  try {
    const forzado = new URLSearchParams(location.search).get('lang') || localStorage.getItem('editorpdf.idioma');
    if (IDIOMAS.includes(forzado)) return forzado;
  } catch { /* sin almacenamiento (p. ej. ventana privada) */ }
  for (const l of navigator.languages?.length ? navigator.languages : [navigator.language || 'es']) {
    const base = String(l).toLowerCase().split('-')[0];
    if (IDIOMAS.includes(base)) return base;
  }
  return 'en';
}

export const LANG = elegir();
let dict = {};
if (LANG !== 'es') {
  try { dict = (await import(`./lang/${LANG}.js`)).default; } catch (err) { console.error('Sin traducción', LANG, err); }
}

/** Texto traducido. Las variables van entre llaves: t('Página {n}', { n: 3 }). */
export function t(s, vars) {
  let out = dict[s] ?? s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return out;
}

const ATRIBUTOS = ['title', 'placeholder', 'aria-label', 'alt'];

/** Traduce los textos escritos en el HTML: nodos de texto y los atributos que se leen o se ven. */
export function translateDom(root = document.body) {
  if (LANG === 'es' || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.nodeValue;
    const key = raw.replace(/\s+/g, ' ').trim();
    if (!key || !(key in dict)) continue;
    n.nodeValue = raw.match(/^\s*/)[0] + dict[key] + raw.match(/\s*$/)[0];
  }
  const els = root.querySelectorAll?.('[title], [placeholder], [aria-label], [alt]') || [];
  for (const el of [root, ...els]) {
    for (const a of ATRIBUTOS) {
      const v = el.getAttribute?.(a)?.trim();
      if (v && v in dict) el.setAttribute(a, dict[v]);
    }
  }
}

document.documentElement.lang = LANG;
// Textos que pone el CSS (content: var(...))
document.documentElement.style.setProperty('--txt-escribe', JSON.stringify(t('Escribe…')));
document.documentElement.style.setProperty('--txt-suelta', JSON.stringify(t('Suelta el archivo aquí')));
translateDom(document.body);
