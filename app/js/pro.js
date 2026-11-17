import { t } from './i18n.js';
// Monetización. App de Android: anuncio antes de guardar o convertir, límite de descargas diarias en la versión
// gratuita y suscripción "Pro" o pago de por vida (Google Play) que quita los anuncios y el límite.
// Versión web (pdfstroke.com): el mismo límite diario y anuncios de AdSense (ver anuncios-web.js). Pro se compra en la
// web con Polar (polar.sh), que da un código de licencia; mientras no esté configurado, solo se ofrece la app de Android.

// ---- Configuración: CAMBIAR antes de publicar (ver LEEME-ANDROID.md, "Anuncios y suscripción") ----
// Identificadores de AdMob (cuenta del autor). El de la app (ca-app-pub-...~...) lo copia
// android-recursos/construir.py de aquí al manifiesto de Android.
export const ADMOB_APP_ID = 'ca-app-pub-7863177549007991~5915702812';
const ADMOB_INTERSTICIAL = 'ca-app-pub-7863177549007991/6522207479';
// Anuncios de prueba de Google: siempre en el APK de prueba (identificador acabado en ".prueba"), para no ver ni
// pulsar nunca anuncios reales al probar (AdMob puede cerrar la cuenta). true = también en la versión de Google Play.
const ANUNCIOS_DE_PRUEBA = false;
const INTERSTICIAL_DE_PRUEBA = 'ca-app-pub-3940256099942544/1033173712';
// Anuncio de "carga de aplicación": al abrir la app y al volver a ella tras un rato fuera
const ADMOB_APERTURA = 'ca-app-pub-7863177549007991/1315248291';
const APERTURA_DE_PRUEBA = 'ca-app-pub-3940256099942544/9257395921';
const APERTURA_ESPERA_MAX = 4000; // ms: si el anuncio tarda más en cargar, no se muestra (no se hace esperar)
const APERTURA_AL_VOLVER = 30 * 60 * 1000; // ms fuera de la app para volver a mostrarlo al regresar
const INTERSTICIAL_ESPERA_MAX = 6000; // ms: al guardar, cuánto se espera (con la rueda girando) a que cargue el anuncio
let testAds = ANUNCIOS_DE_PRUEBA;
// Suscripción creada en la Play Console: producto "pro" con dos planes base, "mensual" y "anual"
const PRODUCTO = 'pro';
// Pago único (producto integrado "pro_vida", no consumible): Pro para siempre
const VIDA = 'pro_vida';
const PLANES = { // precios de reserva si Google Play no responde
  mensual: t('{precio} al mes', { precio: '0,99 €' }),
  anual: t('{precio} al año', { precio: '4,99 €' }),
  vida: t('{precio} pago único', { precio: '8,99 €' }),
};
export const DESCARGAS_GRATIS = 3; // por día

// ---- Pro en la web: Polar (polar.sh) vende como revendedor (merchant of record) y gestiona el IVA ----
// Cada producto de Polar (mensual, anual, de por vida) da la misma ventaja «License Keys»: el comprador recibe un código
// de licencia (en el portal de cliente de Polar, enlazado desde el correo de compra) y lo pega en la web. La web lo
// comprueba con la API pública de Polar (sin clave secreta; admite llamadas desde el navegador).
// Configurado el 17 nov 2026 (Lemon Squeezy rechazó la tienda porque cierra). Productos en Polar: «PDF Stroke Pro —
// Mensual / Anual / De por vida», con la ventaja «PDF Stroke Pro license key» (prefijo PDFS, 3 navegadores):
// - POLAR_ORG: identificador de la organización (Polar › Settings › General › Organization ID).
// - POLAR_PORTAL: portal de cliente, https://polar.sh/<slug-de-la-organización>/portal.
// - WEB_COMPRA: enlaces de compra (Products › Checkout Links) de cada plan. Un plan con el enlace vacío no se
//   muestra; sin organización o sin ningún enlace, en la web solo se ofrece la app de Android.
// - POLAR_API: la de pruebas (sandbox.polar.sh, tarjeta 4242 4242 4242 4242) mientras se prueba.
const POLAR_API = 'https://api.polar.sh'; // pruebas: 'https://sandbox-api.polar.sh'
const POLAR_ORG = '9973acf6-a352-4e26-8f04-da867d16a8e4';
const POLAR_PORTAL = 'https://polar.sh/pdfstroke/portal';
const WEB_COMPRA = {
  mensual: 'https://buy.polar.sh/polar_cl_5B5Rd0zvCSjG3bCBpch4n1VVoXZOv28vuBE5w35zuKe',
  anual: 'https://buy.polar.sh/polar_cl_ICyWhGOxWt4FUsW8HZZfgl4yh9fZbBdIHEFnF1xoK3u',
  vida: 'https://buy.polar.sh/polar_cl_vfmyDVVpJMOPi3i1cJMD97xvY8PPJad1vKNRm0Xz5I9',
};
// Precios de la web (con IVA): los mismos que en Polar; son distintos de los de Google Play
const WEB_PRECIOS = { mensual: '1,99 €', anual: '6,99 €', vida: '12,99 €' };
const hayCompraWeb = () => !!POLAR_ORG && Object.values(WEB_COMPRA).some(Boolean);
const WEB_LICENCIA = 'editorpdf.licencia';
// Última activación de Polar creada en este navegador. Se guarda aparte (no da Pro) para reutilizarla al volver a
// meter el código (p. ej. tras cambiar la clave en el portal, que conserva las activaciones) y no gastar otra plaza.
const WEB_ACTIVACION = 'editorpdf.activacionPolar';
const POLAR_ESPERA = 15000; // ms: si Polar no responde, se trata como sin conexión
const PLAY_URL = 'https://play.google.com/store/apps/details?id=es.pdfstrike.app';

const cap = window.Capacitor?.isNativePlatform?.() ? window.Capacitor : null;
const AdMob = cap?.Plugins?.AdMob;
const Billing = cap?.Plugins?.NativePurchases;
const $ = (id) => document.getElementById(id);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

let pro = store.get('editorpdf.pro', false);
// en la web: licencia Pro de Polar activada en este navegador (las antiguas de prueba de Lemon Squeezy no cuentan)
const licenciaGuardada = () => { const l = store.get(WEB_LICENCIA, null); return l?.key && l.proveedor === 'polar' && l.org === POLAR_ORG ? l : null; };
let webPro = hayCompraWeb() && !!licenciaGuardada();
let proVida = store.get('editorpdf.proVida', false); // Pro comprado de por vida (no hay suscripción que gestionar)
let adReady = false;
let adsStarted = null;
let preparing = null; // carga del anuncio intersticial en curso
let showingAd = false; // hay un anuncio a pantalla completa abierto

/** ¿Tiene Pro? (en la app: Google Play; en la web: licencia activada en este navegador) */
export const isPro = () => (cap ? pro : webPro);
export const isNativeApp = () => !!cap;

function setPro(v, vida = false) {
  pro = !!v;
  proVida = pro && vida;
  store.set('editorpdf.pro', pro);
  store.set('editorpdf.proVida', proVida);
  document.body.classList.toggle('is-pro', pro);
}

// ---------- Suscripción ----------
// El plugin de Google Play usa una única conexión y cada llamada cierra la anterior: si se hacen dos a la vez, una
// corta a la otra (falla o no responde nunca) y la app no se enteraba de que el usuario había comprado Pro. Por eso
// todas las llamadas van en cola, de una en una. Quien llama recibe un error si tarda demasiado (`espera`), pero la
// siguiente llamada espera a que esta termine de verdad (como mucho `tope`): si se adelantara, la respuesta tardía de
// esta cerraría la conexión de la siguiente. La compra espera a que el usuario termine en la ventana de Google Play.
const COLA_TOPE = 60000;
const COMPRA_MAX = 15 * 60000;
const COMPROBAR_AL_VOLVER = 5 * 60000; // al volver a la app, se vuelve a comprobar Pro si hace más de esto

function conLimite(p, ms, msg) {
  if (!ms) return p;
  let reloj;
  const limite = new Promise((_, rechazar) => { reloj = setTimeout(() => rechazar(new Error(msg)), ms); });
  return Promise.race([p, limite]).finally(() => clearTimeout(reloj));
}

let colaBilling = Promise.resolve();
function billing(metodo, opciones, espera = 30000, tope = COLA_TOPE) {
  const turno = colaBilling.then(() => {
    const nativa = Promise.resolve().then(() => Billing[metodo](opciones));
    return { nativa, libre: conLimite(nativa, tope, 'tope').catch(() => {}) };
  });
  colaBilling = turno.then((x) => x.libre);
  return turno.then((x) => conLimite(x.nativa, espera, `Google Play no responde (${metodo})`));
}

let ultimaComprobacion = 0;
/**
 * Comprueba con Google Play si hay una suscripción Pro activa o un pago de por vida (al arrancar, al volver a la app y
 * tras comprar o restaurar). `confirmada`: producto cuyo pago acaba de terminar bien (cuenta aunque la consulta aún no
 * lo traiga). `lanzar`: si la consulta falla, lanza el error (si no, se mantiene lo último que se supo).
 */
export async function checkPro({ confirmada = null, lanzar = false } = {}) {
  if (!Billing) return isPro();
  ultimaComprobacion = Date.now();
  try {
    // Suscripciones y pago único en una sola consulta (una sola conexión)
    const res = await billing('getPurchases', {});
    if (!Array.isArray(res?.purchases)) throw new Error('Google Play no ha devuelto las compras');
    const validas = res.purchases.filter((tr) => tr.purchaseState === '1' || tr.isActive);
    // Reconoce (acknowledge) las compras que aún no lo están: las hechas fuera de la app (p. ej. un código de promoción
    // canjeado en Play Store) y las de la app cuyo reconocimiento automático no llegó a completarse (el plugin cierra la
    // conexión sin esperarlo). Si no se reconocen en 3 días, Google las anula y devuelve el dinero.
    for (const tr of validas) {
      if (tr.isAcknowledged === false && tr.purchaseToken) {
        try { await billing('acknowledgePurchase', { purchaseToken: tr.purchaseToken }); } catch (err) { console.warn('No se pudo reconocer la compra', err); }
      }
    }
    const vida = confirmada === VIDA || validas.some((tr) => tr.productIdentifier === VIDA);
    setPro(vida || !!confirmada || validas.some((tr) => tr.productIdentifier === PRODUCTO), vida);
  } catch (err) {
    console.warn('No se pudo comprobar la suscripción', err); // sin conexión: se mantiene lo último que se supo
    if (lanzar) throw err;
  }
  return pro;
}

async function prices() {
  const out = { ...PLANES };
  try {
    const { products } = await billing('getProducts', { productIdentifiers: [PRODUCTO], productType: 'subs' });
    for (const p of products) {
      if (p.offerId) continue; // ofertas especiales (p. ej. una prueba gratis): se muestra el precio normal del plan
      const plan = p.identifier || p.planIdentifier; // el plan base («mensual» o «anual») viene en `identifier`
      if (plan === 'mensual') out.mensual = t('{precio} al mes', { precio: p.priceString });
      if (plan === 'anual') out.anual = t('{precio} al año', { precio: p.priceString });
    }
  } catch (err) { console.warn('Precios no disponibles', err); }
  try {
    const { products } = await billing('getProducts', { productIdentifiers: [VIDA], productType: 'inapp' });
    if (products[0]?.priceString) out.vida = t('{precio} pago único', { precio: products[0].priceString });
  } catch (err) { console.warn('Precio de por vida no disponible', err); }
  return out;
}

async function buy(plan) {
  const producto = plan === 'vida' ? VIDA : PRODUCTO;
  let compra;
  try {
    compra = await billing('purchaseProduct', plan === 'vida'
      ? { productIdentifier: VIDA, productType: 'inapp', autoAcknowledgePurchases: true }
      : { productIdentifier: PRODUCTO, planIdentifier: plan, productType: 'subs', autoAcknowledgePurchases: true },
    COMPRA_MAX, COMPRA_MAX);
  } catch (err) {
    // «Ya tienes este artículo»: ya estaba comprado (p. ej. la app no llegó a enterarse); se comprueba otra vez
    if (err?.code === 'ITEM_ALREADY_OWNED') { await checkPro({ lanzar: true }); return; }
    throw err;
  }
  // El pago ha terminado bien: cuenta ya, aunque la consulta de después (que además reconoce la compra) no lo traiga
  const ok = compra?.purchaseState === '1' && compra.productIdentifier === producto;
  if (ok) setPro(true, producto === VIDA);
  await checkPro({ confirmada: ok ? producto : null });
}

let ocupado = false; // compra o comprobación en curso en la ventana Pro (un segundo toque no abre otra)

/**
 * Ventana de la suscripción Pro. `motivo` es el texto de arriba (p. ej. que se ha llegado al límite).
 * Devuelve true si al cerrarla el usuario es Pro.
 */
export function showPro(motivo = '') {
  if (!cap) return showProWeb(motivo);
  return new Promise((resolve) => {
    const modal = $('proModal');
    $('proReason').textContent = motivo;
    $('proReason').hidden = !motivo;
    // Qué tipo de Pro tiene: el pago de por vida no es una suscripción (no aparece en Google Play para cancelarla)
    $('proStatus').textContent = !pro ? '' : proVida
      ? t('Tienes PDF Stroke Pro de por vida. ¡Gracias! No hay ninguna suscripción que cancelar.')
      : t('Tienes la suscripción PDF Stroke Pro. ¡Gracias! Puedes cancelarla en «Gestionar suscripción».');
    modal.querySelector('.pro-plans').hidden = pro;
    $('proManage').hidden = false; // siempre: abre las suscripciones de Google Play para verlas o cancelarlas
    $('proRestoreHint').hidden = false;
    $('proPrivacy').hidden = pro || !AdMob;
    modal.hidden = false;
    prices().then((p) => { $('proMonthly').textContent = p.mensual; $('proYearly').textContent = p.anual; $('proLifetime').textContent = p.vida; });
    const close = () => {
      modal.hidden = true;
      for (const [id, fn] of handlers) $(id).removeEventListener('click', fn);
      resolve(pro);
    };
    const busy = (txt) => { $('proStatus').textContent = txt; };
    const attempt = (fn) => async () => {
      if (ocupado) return;
      ocupado = true;
      try {
        busy(t('Un momento…'));
        await fn();
        busy(pro ? t('¡Listo! Ya tienes PDF Stroke Pro.') : t('No se ha encontrado ninguna suscripción activa.'));
        if (pro) setTimeout(close, 900);
      } catch (err) {
        // El plugin pone el motivo en `code` (USER_CANCELED, ITEM_ALREADY_OWNED…) y una frase genérica en `message`
        const msg = `${err?.message || err} ${err?.code || ''}`;
        console.warn('Suscripción', msg);
        busy(/cancel/i.test(msg) ? ''
          : /pending/i.test(msg)
            ? t('Pago pendiente: PDF Stroke Pro se activará cuando Google Play lo confirme.')
            : /BILLING_SETUP|UNAVAILABLE|SERVICE|network|no responde|QUERY_PURCHASES|devuelto/i.test(msg)
              ? t('Google Play no está disponible ahora. Comprueba la conexión y que tienes una cuenta de Google en el móvil.')
              : /not found|ITEM_UNAVAILABLE|no product/i.test(msg)
                ? t('La suscripción aún no está disponible. Inténtalo más tarde.')
                : t('No se ha podido completar la compra. Inténtalo de nuevo.'));
      } finally {
        ocupado = false;
      }
    };
    const handlers = [
      ['proBuyMonthly', attempt(() => buy('mensual'))],
      ['proBuyYearly', attempt(() => buy('anual'))],
      ['proBuyLifetime', attempt(() => buy('vida'))],
      ['proRestore', attempt(() => checkPro({ lanzar: true }))], // (checkPro ya reconoce las compras pendientes)
      ['proManage', () => Billing.manageSubscriptions().catch(() => {})],
      ['proPrivacy', () => privacyOptions()],
      ['proClose', close],
    ];
    for (const [id, fn] of handlers) $(id).addEventListener('click', fn);
  });
}

// ---------- Pro en la web (código de licencia de Polar) ----------
const sinConexion = () => new Error(t('No se pudo comprobar el código. Revisa la conexión.'));

/** Llama a la API pública de licencias de Polar. Devuelve { estado: código HTTP, cuerpo: JSON o null }.
 *  Si no hay conexión o Polar tarda más de POLAR_ESPERA, lanza el error traducido de «sin conexión». */
async function polar(accion, datos) {
  const ctl = new AbortController();
  const reloj = setTimeout(() => ctl.abort(), POLAR_ESPERA);
  try {
    const r = await fetch(`${POLAR_API}/v1/customer-portal/license-keys/${accion}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ organization_id: POLAR_ORG, ...datos }),
      signal: ctl.signal,
    });
    let cuerpo = null;
    try { cuerpo = await r.json(); } catch { /* sin cuerpo */ }
    return { estado: r.status, cuerpo };
  } catch {
    throw sinConexion(); // «Failed to fetch», «Load failed» (Safari), corte por tiempo…
  } finally {
    clearTimeout(reloj);
  }
}

// Polar responde 200 solo si el código está vigente; 404 si no existe, se revocó (suscripción terminada), está
// desactivado o caducado, o si la activación indicada no existe (se liberó en el portal); 422 si el formato no vale.
const noExiste = (r) => r.estado === 404 || r.estado === 422;
const vigente = (k) => k?.status === 'granted' && (!k.expires_at || new Date(k.expires_at) > new Date());

function quitarProWeb() {
  store.set(WEB_LICENCIA, null); // la activación sigue en WEB_ACTIVACION para reutilizarla
  webPro = false;
  document.body.classList.remove('is-pro');
}

/** Nombre de la activación en el portal de Polar, para que el cliente sepa qué navegador liberar. */
function etiquetaNavegador() {
  const ua = navigator.userAgent || '';
  const nav = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const so = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `PDF Stroke web · ${nav}${so ? ' / ' + so : ''} · ${new Date().toLocaleString('sv').slice(0, 16)}`;
}

/** Activa en este navegador un código de licencia comprado en la web. */
async function activarLicencia(codigo) {
  const v = await polar('validate', { key: codigo });
  if (noExiste(v)) throw new Error(t('El código no es válido o ya no está activo (suscripción cancelada o caducada).'));
  if (v.estado !== 200 || !v.cuerpo) throw sinConexion();
  if (!vigente(v.cuerpo)) throw new Error(t('El código no es válido o ya no está activo (suscripción cancelada o caducada).'));
  let activacion = null;
  if (v.cuerpo.limit_activations) { // límite de navegadores por código (3, puesto en Polar)
    const previa = store.get(WEB_ACTIVACION, null);
    if (previa?.org === POLAR_ORG && previa.licencia === v.cuerpo.id && previa.activation) {
      const r = await polar('validate', { key: codigo, activation_id: previa.activation }); // ¿sigue existiendo?
      if (r.estado === 200 && vigente(r.cuerpo)) activacion = previa.activation;
    }
    if (!activacion) {
      const a = await polar('activate', { key: codigo, label: etiquetaNavegador() });
      if (a.estado === 403) throw new Error(t('Este código ya está activado en el máximo de navegadores. Puedes liberar alguno en el portal de cliente de Polar.'));
      if (a.estado !== 200 || !a.cuerpo?.id) throw sinConexion();
      activacion = a.cuerpo.id;
      store.set(WEB_ACTIVACION, { org: POLAR_ORG, licencia: v.cuerpo.id, activation: activacion });
    }
  }
  store.set(WEB_LICENCIA, { proveedor: 'polar', org: POLAR_ORG, key: codigo, activation: activacion });
  webPro = true;
  document.body.classList.add('is-pro');
}

/** Al abrir la web: el código sigue siendo válido (si no hay conexión o Polar falla, se mantiene Pro). */
async function comprobarLicenciaWeb() {
  if (!hayCompraWeb()) return;
  const l = licenciaGuardada();
  if (!l) { if (store.get(WEB_LICENCIA, null)) quitarProWeb(); return; } // licencia antigua (Lemon Squeezy u otra tienda)
  try {
    const r = await polar('validate', { key: l.key, ...(l.activation ? { activation_id: l.activation } : {}) });
    if (noExiste(r) || (r.estado === 200 && r.cuerpo && !vigente(r.cuerpo))) quitarProWeb();
  } catch { /* sin conexión: se mantiene */ }
}

let activando = false; // hay una activación en curso (la ventana es una sola aunque se abra varias veces)

function showProWeb(motivo) {
  return new Promise((resolve) => {
    const modal = $('proModal');
    modal.classList.add('web');
    $('proReason').textContent = motivo;
    $('proReason').hidden = !motivo;
    $('proStatus').textContent = webPro ? t('Ya tienes PDF Stroke Pro. ¡Gracias!') : activando ? t('Un momento…') : '';
    modal.querySelector('.pro-plans').hidden = true;
    $('proManage').hidden = !(webPro && POLAR_PORTAL); // suscripción, recibos y código: en el portal de Polar
    $('proPrivacy').hidden = true;
    $('proRestore').hidden = true;
    $('proRestoreHint').hidden = true;
    $('proWeb').hidden = webPro;
    $('proWebBuy').hidden = !hayCompraWeb();
    $('proWebKey').hidden = !hayCompraWeb();
    $('proWebHint').hidden = !hayCompraWeb() || !POLAR_PORTAL;
    $('proWebActivate').disabled = activando;
    const textos = {
      mensual: t('{precio} al mes', { precio: WEB_PRECIOS.mensual }),
      anual: t('{precio} al año', { precio: WEB_PRECIOS.anual }),
      vida: t('{precio} pago único', { precio: WEB_PRECIOS.vida }),
    };
    for (const b of $('proWebBuy').querySelectorAll('[data-plan]')) {
      b.hidden = !WEB_COMPRA[b.dataset.plan];
      b.querySelector('small').textContent = textos[b.dataset.plan];
    }
    modal.hidden = false;
    let cerrada = false;
    const close = () => {
      if (cerrada) return; // p. ej. el cierre retrasado tras activar, si ya se cerró con la X
      cerrada = true;
      modal.hidden = true;
      modal.classList.remove('web');
      $('proWeb').hidden = true;
      $('proRestore').hidden = false;
      $('proManage').hidden = true;
      for (const [id, fn] of handlers) $(id).removeEventListener('click', fn);
      resolve(webPro);
    };
    const handlers = [
      ['proWebBuy', (e) => { const b = e.target.closest('[data-plan]'); if (b && WEB_COMPRA[b.dataset.plan]) window.open(WEB_COMPRA[b.dataset.plan], '_blank', 'noopener'); }],
      ['proWebApp', () => window.open(PLAY_URL, '_blank', 'noopener')],
      ['proWebPortal', (e) => { e.preventDefault(); window.open(POLAR_PORTAL, '_blank', 'noopener'); }],
      ['proManage', () => window.open(POLAR_PORTAL, '_blank', 'noopener')],
      ['proWebActivate', async () => {
        const code = $('proWebCode').value.trim();
        if (!code || activando) return; // un doble toque no crea dos activaciones
        activando = true;
        $('proWebActivate').disabled = true;
        $('proStatus').textContent = t('Un momento…');
        let ok = false;
        try {
          await activarLicencia(code);
          ok = true;
        } catch (err) {
          if (!cerrada) $('proStatus').textContent = err?.message || sinConexion().message;
        } finally {
          activando = false;
        }
        if (ok) {
          if (cerrada) return; // se cerró mientras se comprobaba: Pro ya queda activado, sin tocar otra ventana
          $('proStatus').textContent = t('¡Listo! Ya tienes PDF Stroke Pro.');
          $('proWeb').hidden = true;
          setTimeout(close, 900);
        } else {
          $('proWebActivate').disabled = false;
        }
      }],
      ['proClose', close],
    ];
    for (const [id, fn] of handlers) $(id).addEventListener('click', fn);
  });
}

// ---------- Límite de descargas ----------
const today = () => new Date().toLocaleDateString('sv'); // AAAA-MM-DD en la hora del móvil (cambia a medianoche)
function usedToday() {
  const d = store.get('editorpdf.descargas', null);
  return d && d.dia === today() ? d.n : 0;
}

/**
 * Antes de guardar, compartir o convertir: con Pro (o en la web) siempre se puede; si no, mientras queden descargas
 * gratuitas hoy. Si no quedan, ofrece Pro. Devuelve true si se puede seguir.
 */
export async function canDownload() {
  if (isPro()) return true;
  if (usedToday() < DESCARGAS_GRATIS) return true;
  return showPro(t('Has usado las {n} descargas gratuitas de hoy. Con Pro, sin límite y sin anuncios (o vuelve mañana).', { n: DESCARGAS_GRATIS }));
}

/**
 * Antes de entregar el archivo (versión gratuita): muestra el anuncio y espera a que se cierre. Así el archivo no
 * existe hasta después del anuncio y no se puede salir de la app con él ya guardado.
 */
export async function adBeforeDownload() {
  if (!isPro()) await showInterstitial();
}

/**
 * Cuenta una descarga ya hecha. Devuelve un texto con las descargas gratuitas que quedan hoy (vacío con Pro o en
 * la web), para el aviso.
 */
export function countDownload() {
  if (isPro()) return '';
  store.set('editorpdf.descargas', { dia: today(), n: usedToday() + 1 });
  const left = Math.max(0, DESCARGAS_GRATIS - usedToday());
  if (left === 0) return t('Era la última descarga gratuita de hoy.');
  return left === 1 ? t('Te queda 1 descarga gratuita hoy.') : t('Te quedan {n} descargas gratuitas hoy.', { n: left });
}

// ---------- Anuncios ----------
function prepareAd() {
  if (!AdMob || pro || adReady) return Promise.resolve();
  preparing ||= (async () => {
    try {
      await AdMob.prepareInterstitial({ adId: testAds ? INTERSTICIAL_DE_PRUEBA : ADMOB_INTERSTICIAL, isTesting: testAds });
      adReady = true;
    } catch (err) {
      adReady = false;
      console.warn('Anuncio no disponible', err);
    } finally {
      preparing = null;
    }
  })();
  return preparing;
}

/** Rueda girando a pantalla completa (la misma de «Procesando…») mientras se espera al anuncio. */
function waiting(on) {
  $('busyText').textContent = on ? t('Un momento…') : '';
  $('busy').hidden = !on;
}

/** Espera a que se cierre un anuncio a pantalla completa (o a que falle); `show` lo muestra. */
async function untilClosed(show, closedEvents) {
  const handles = [];
  showingAd = true;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 120000); // por si no llega el aviso de cierre
      const done = () => { clearTimeout(timer); resolve(); };
      for (const ev of closedEvents) handles.push(AdMob.addListener(ev, done));
      show().catch((err) => { clearTimeout(timer); reject(err); });
    });
  } finally {
    showingAd = false;
    for (const h of handles) Promise.resolve(h).then((x) => x?.remove?.()).catch(() => {});
  }
}

/** Anuncio de apertura: se carga y, si llega a tiempo y la app sigue a la vista, se muestra. */
async function showAppOpen() {
  if (!AdMob?.loadAppOpen || pro || showingAd) return;
  try {
    const adId = testAds ? APERTURA_DE_PRUEBA : ADMOB_APERTURA;
    const loaded = await Promise.race([
      AdMob.loadAppOpen({ adId }).then(() => true),
      new Promise((r) => setTimeout(() => r(false), APERTURA_ESPERA_MAX)),
    ]);
    // Si ha tardado demasiado, o el usuario ya ha salido o está en otra cosa a pantalla completa, no se muestra
    if (!loaded || document.hidden || showingAd || !$('proModal').hidden || !$('busy').hidden) return;
    await untilClosed(() => AdMob.showAppOpen(), ['appOpenAdClosed', 'appOpenAdFailedToShow']);
  } catch (err) {
    console.warn('Anuncio de apertura no disponible', err);
  }
}

async function showInterstitial() {
  if (!AdMob || pro) return;
  if (!adReady) {
    // Aún no está cargado: se espera unos segundos con la rueda girando. Si no llega (sin conexión...), se guarda
    // sin anuncio y se sigue cargando para la próxima vez.
    waiting(true);
    try {
      await Promise.race([
        (async () => { await adsStarted; await prepareAd(); })(),
        new Promise((r) => setTimeout(r, INTERSTICIAL_ESPERA_MAX)),
      ]);
    } finally {
      waiting(false);
    }
    if (!adReady) return;
  }
  if (showingAd) return; // ya hay otro anuncio abierto
  adReady = false;
  // showInterstitial() termina al aparecer el anuncio: se espera a que el usuario lo cierre (o a que falle)
  try {
    await untilClosed(() => AdMob.showInterstitial(), ['interstitialAdDismissed', 'interstitialAdFailedToShow']);
  } catch (err) {
    console.warn('No se pudo mostrar el anuncio', err);
  }
  prepareAd();
}

/** Al arrancar la app: suscripción, consentimiento de anuncios (obligatorio en la UE) y primer anuncio. */
export function startMonetization() {
  document.body.classList.toggle('is-native', !!cap);
  document.body.classList.toggle('is-pro', isPro());
  if (!cap) { comprobarLicenciaWeb(); return; }
  adsStarted = (async () => {
    try {
      const info = await cap.Plugins.App?.getInfo();
      if (info?.id?.endsWith('.prueba')) testAds = true;
    } catch { /* sin datos de la app: se usa la configuración de arriba */ }
    await checkPro();
    if (!AdMob || pro) return;
    try {
      await AdMob.initialize({ initializeForTesting: testAds });
      const info = await AdMob.requestConsentInfo();
      if (info.isConsentFormAvailable && info.status === 'REQUIRED') await AdMob.showConsentForm();
    } catch (err) {
      console.warn('AdMob no se pudo iniciar', err);
    }
    await showAppOpen();
    await prepareAd();
  })();
  // Al volver a la app después de un buen rato fuera, otro anuncio de apertura
  let leftAt = 0;
  cap.Plugins.App?.addListener('appStateChange', ({ isActive }) => {
    // Al volver, Pro se comprueba otra vez (p. ej. un pago pendiente que Google Play ya ha confirmado)
    if (isActive && Date.now() - ultimaComprobacion >= COMPROBAR_AL_VOLVER) checkPro();
    if (showingAd) return; // los anuncios tapan la app: eso no cuenta como salir
    if (!isActive) { leftAt = Date.now(); return; }
    if (leftAt && Date.now() - leftAt >= APERTURA_AL_VOLVER) { leftAt = 0; adsStarted.then(showAppOpen); }
  });
}

/** Formulario de privacidad de los anuncios (para cambiar el consentimiento más tarde). */
export function privacyOptions() {
  return AdMob?.showPrivacyOptionsForm().catch(() => {});
}
