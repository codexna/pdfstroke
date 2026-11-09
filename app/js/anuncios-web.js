// Anuncios de la versión web (pdfstroke.com) con Google AdSense: uno en la pantalla de inicio y otro en el aviso
// «Archivo descargado». No se muestran en la app de Android (allí van los de AdMob) ni con Pro.
// El aviso de consentimiento (cookies, obligatorio en la UE) lo pone el propio AdSense: se configura en AdSense ›
// Privacidad y mensajes.

// ---- Configuración: CAMBIAR cuando Google apruebe la web (ver LEEME-ANDROID.md, «Versión web») ----
const CLIENTE = 'ca-pub-7863177549007991'; // el mismo identificador de editor que AdMob (comprobar en AdSense)
// Bloques de anuncios (AdSense › Anuncios › Por bloque de anuncios › Anuncio de display). Vacío = sin anuncio.
const BLOQUES = { inicio: '', descarga: '' };

const cap = window.Capacitor?.isNativePlatform?.();
let cargado = null;

function cargar() {
  cargado ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + CLIENTE;
    s.onload = res;
    s.onerror = () => { cargado = null; rej(new Error('AdSense no disponible')); };
    document.head.appendChild(s);
  });
  return cargado;
}

const activo = () => !cap && !document.body.classList.contains('is-pro') && /pdfstroke\.com$/.test(location.hostname);

function poner(id, bloque) {
  const box = document.getElementById(id);
  if (!box || !bloque || !activo()) return;
  box.innerHTML = '';
  const ins = document.createElement('ins');
  ins.className = 'adsbygoogle';
  ins.style.display = 'block';
  ins.dataset.adClient = CLIENTE;
  ins.dataset.adSlot = bloque;
  ins.dataset.adFormat = 'auto';
  ins.dataset.fullWidthResponsive = 'true';
  box.appendChild(ins);
  box.hidden = false;
  cargar().then(() => { (window.adsbygoogle = window.adsbygoogle || []).push({}); }).catch(() => { box.hidden = true; });
}

export function initWebAds() {
  if (!activo()) return;
  // El script se carga siempre en la web (también lo necesita Google para revisar y aprobar el sitio)
  cargar().catch(() => {});
  poner('adInicio', BLOQUES.inicio);
}

/** Anuncio en el aviso de descarga (uno nuevo cada vez). */
export function showWebAd(donde) {
  if (donde === 'descarga') poner('adDescarga', BLOQUES.descarga);
}
