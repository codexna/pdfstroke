import { t } from './i18n.js';
// Monetización. App de Android: anuncio antes de guardar o convertir, límite de descargas diarias en la versión
// gratuita y suscripción "Pro" o pago de por vida (Google Play) que quita los anuncios y el límite.
// Versión web (pdfstroke.com): el mismo límite diario; Pro se compra en la web (Lemon Squeezy, que da un código de
// licencia) y los anuncios son de AdSense (ver anuncios-web.js).

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

// ---- Pro en la web: tienda de Lemon Squeezy (CAMBIAR al crear la cuenta; ver LEEME-ANDROID.md, «Versión web») ----
// Enlace de compra (checkout) del producto «PDF Stroke Pro (web)» y número de la tienda (para comprobar que la
// licencia es de esta tienda). Mientras estén vacíos, en la web solo se ofrece la app de Android.
const WEB_COMPRA = '';
const WEB_TIENDA = 0;
const WEB_LICENCIA = 'editorpdf.licencia';
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
let webPro = !!store.get(WEB_LICENCIA, null); // en la web: licencia Pro activada en este navegador
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
/** Comprueba con Google Play si hay una suscripción Pro activa (al arrancar y tras comprar o restaurar). */
export async function checkPro() {
  if (!Billing) return isPro();
  try {
    // Reconoce (acknowledge) las compras hechas fuera de la app, p. ej. un código de promoción canjeado
    // en Play Store: si no se reconocen en 3 días, Google las anula. getPurchases no lo hace; restorePurchases sí.
    try { await Billing.restorePurchases(); } catch (err) { console.warn('No se pudieron reconocer compras pendientes', err); }
    const valida = (t) => t.purchaseState === '1' || t.isActive;
    const [subs, inapp] = await Promise.all([
      Billing.getPurchases({ productType: 'subs', onlyCurrentEntitlements: true }),
      Billing.getPurchases({ productType: 'inapp', onlyCurrentEntitlements: true }),
    ]);
    const vida = inapp.purchases.some((t) => t.productIdentifier === VIDA && valida(t));
    setPro(vida || subs.purchases.some((t) => t.productIdentifier === PRODUCTO && valida(t)), vida);
  } catch (err) {
    console.warn('No se pudo comprobar la suscripción', err); // sin conexión: se mantiene lo último que se supo
  }
  return pro;
}

async function prices() {
  const out = { ...PLANES };
  try {
    const { products } = await Billing.getProducts({ productIdentifiers: [PRODUCTO], productType: 'subs' });
    for (const p of products) {
      if (p.planIdentifier === 'mensual') out.mensual = t('{precio} al mes', { precio: p.priceString });
      if (p.planIdentifier === 'anual') out.anual = t('{precio} al año', { precio: p.priceString });
    }
  } catch (err) { console.warn('Precios no disponibles', err); }
  try {
    const { products } = await Billing.getProducts({ productIdentifiers: [VIDA], productType: 'inapp' });
    if (products[0]?.priceString) out.vida = t('{precio} pago único', { precio: products[0].priceString });
  } catch (err) { console.warn('Precio de por vida no disponible', err); }
  return out;
}

async function buy(plan) {
  await Billing.purchaseProduct(plan === 'vida'
    ? { productIdentifier: VIDA, productType: 'inapp', autoAcknowledgePurchases: true }
    : { productIdentifier: PRODUCTO, planIdentifier: plan, productType: 'subs', autoAcknowledgePurchases: true });
  await checkPro();
}

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
    $('proStatus').textContent = pro ? t('Ya tienes PDF Stroke Pro. ¡Gracias!') : '';
    modal.querySelector('.pro-plans').hidden = pro;
    $('proManage').hidden = !pro || proVida;
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
      try {
        busy(t('Un momento…'));
        await fn();
        busy(pro ? t('¡Listo! Ya tienes PDF Stroke Pro.') : t('No se ha encontrado ninguna suscripción activa.'));
        if (pro) setTimeout(close, 900);
      } catch (err) {
        const msg = String(err?.message || err);
        console.warn('Suscripción', msg);
        busy(/cancel/i.test(msg) ? ''
          : /BILLING_SETUP|UNAVAILABLE|SERVICE|network/i.test(msg)
            ? t('Google Play no está disponible ahora. Comprueba la conexión y que tienes una cuenta de Google en el móvil.')
            : /not found|ITEM_UNAVAILABLE|no product/i.test(msg)
              ? t('La suscripción aún no está disponible. Inténtalo más tarde.')
              : t('No se ha podido completar la compra. Inténtalo de nuevo.'));
      }
    };
    const handlers = [
      ['proBuyMonthly', attempt(() => buy('mensual'))],
      ['proBuyYearly', attempt(() => buy('anual'))],
      ['proBuyLifetime', attempt(() => buy('vida'))],
      ['proRestore', attempt(async () => { await Billing.restorePurchases(); await checkPro(); })],
      ['proManage', () => Billing.manageSubscriptions().catch(() => {})],
      ['proPrivacy', () => privacyOptions()],
      ['proClose', close],
    ];
    for (const [id, fn] of handlers) $(id).addEventListener('click', fn);
  });
}

// ---------- Pro en la web (licencia de Lemon Squeezy) ----------
async function licencia(accion, datos) {
  const body = new URLSearchParams(datos);
  const r = await fetch('https://api.lemonsqueezy.com/v1/licenses/' + accion, {
    method: 'POST', headers: { Accept: 'application/json' }, body,
  });
  return r.json();
}

/** Activa en este navegador un código de licencia comprado en la web. */
async function activarLicencia(codigo) {
  const r = await licencia('activate', { license_key: codigo, instance_name: 'Navegador ' + new Date().toISOString().slice(0, 10) });
  if (!r?.activated && !r?.valid) throw new Error(r?.error || t('El código no es válido.'));
  if (WEB_TIENDA && r.meta?.store_id !== WEB_TIENDA) throw new Error(t('El código no es de PDF Stroke.'));
  store.set(WEB_LICENCIA, { key: codigo, instance: r.instance?.id || null });
  webPro = true;
  document.body.classList.add('is-pro');
}

/** Al abrir la web: la licencia sigue siendo válida (si no hay conexión, se mantiene). */
async function comprobarLicenciaWeb() {
  const l = store.get(WEB_LICENCIA, null);
  if (!l?.key) return;
  try {
    const r = await licencia('validate', { license_key: l.key, ...(l.instance ? { instance_id: l.instance } : {}) });
    if (r && r.valid === false) { store.set(WEB_LICENCIA, null); webPro = false; document.body.classList.remove('is-pro'); }
  } catch { /* sin conexión */ }
}

function showProWeb(motivo) {
  return new Promise((resolve) => {
    const modal = $('proModal');
    modal.classList.add('web');
    $('proReason').textContent = motivo;
    $('proReason').hidden = !motivo;
    $('proStatus').textContent = webPro ? t('Ya tienes PDF Stroke Pro. ¡Gracias!') : '';
    modal.querySelector('.pro-plans').hidden = true;
    $('proManage').hidden = true;
    $('proPrivacy').hidden = true;
    $('proRestore').hidden = true;
    $('proWeb').hidden = webPro;
    $('proWebBuy').hidden = !WEB_COMPRA;
    $('proWebKey').hidden = !WEB_COMPRA;
    modal.hidden = false;
    const close = () => {
      modal.hidden = true;
      modal.classList.remove('web');
      $('proWeb').hidden = true;
      $('proRestore').hidden = false;
      for (const [id, fn] of handlers) $(id).removeEventListener('click', fn);
      resolve(webPro);
    };
    const handlers = [
      ['proWebBuy', () => window.open(WEB_COMPRA, '_blank', 'noopener')],
      ['proWebApp', () => window.open(PLAY_URL, '_blank', 'noopener')],
      ['proWebActivate', async () => {
        const code = $('proWebCode').value.trim();
        if (!code) return;
        $('proStatus').textContent = t('Un momento…');
        try {
          await activarLicencia(code);
          $('proStatus').textContent = t('¡Listo! Ya tienes PDF Stroke Pro.');
          setTimeout(close, 900);
        } catch (err) {
          $('proStatus').textContent = (err?.message && !/fetch/i.test(err.message)) ? err.message : t('No se pudo comprobar el código. Revisa la conexión.');
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
    if (showingAd) return; // los anuncios tapan la app: eso no cuenta como salir
    if (!isActive) { leftAt = Date.now(); return; }
    if (leftAt && Date.now() - leftAt >= APERTURA_AL_VOLVER) { leftAt = 0; adsStarted.then(showAppOpen); }
  });
}

/** Formulario de privacidad de los anuncios (para cambiar el consentimiento más tarde). */
export function privacyOptions() {
  return AdMob?.showPrivacyOptionsForm().catch(() => {});
}
