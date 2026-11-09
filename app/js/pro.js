import { t } from './i18n.js';
// Monetización (sólo en la app de Android): anuncio intersticial después de guardar o convertir, límite de descargas
// diarias en la versión gratuita y suscripción "Pro" (Google Play) que quita los anuncios y el límite.
// En el navegador (versión web) no hay anuncios ni límite.

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
let testAds = ANUNCIOS_DE_PRUEBA;
// Suscripción creada en la Play Console: producto "pro" con dos planes base, "mensual" y "anual"
const PRODUCTO = 'pro';
const PLANES = { mensual: t('{precio} al mes', { precio: '0,99 €' }), anual: t('{precio} al año', { precio: '7,99 €' }) }; // precios de reserva si Google Play no responde
export const DESCARGAS_GRATIS = 3; // por día

const cap = window.Capacitor?.isNativePlatform?.() ? window.Capacitor : null;
const AdMob = cap?.Plugins?.AdMob;
const Billing = cap?.Plugins?.NativePurchases;
const $ = (id) => document.getElementById(id);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

let pro = store.get('editorpdf.pro', false);
let adReady = false;
let adsStarted = null;
let showingAd = false; // hay un anuncio a pantalla completa abierto
let lastAdClosed = 0; // cuándo se cerró el último (para no encadenar dos anuncios seguidos)

/** ¿Tiene la suscripción Pro? (en la versión web, todo está disponible) */
export const isPro = () => !cap || pro;
export const isNativeApp = () => !!cap;

function setPro(v) {
  pro = !!v;
  store.set('editorpdf.pro', pro);
  document.body.classList.toggle('is-pro', pro);
}

// ---------- Suscripción ----------
/** Comprueba con Google Play si hay una suscripción Pro activa (al arrancar y tras comprar o restaurar). */
export async function checkPro() {
  if (!Billing) return isPro();
  try {
    const { purchases } = await Billing.getPurchases({ productType: 'subs', onlyCurrentEntitlements: true });
    setPro(purchases.some((t) => t.productIdentifier === PRODUCTO && (t.purchaseState === '1' || t.isActive)));
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
  return out;
}

async function buy(plan) {
  await Billing.purchaseProduct({
    productIdentifier: PRODUCTO, planIdentifier: plan, productType: 'subs', autoAcknowledgePurchases: true,
  });
  await checkPro();
}

/**
 * Ventana de la suscripción Pro. `motivo` es el texto de arriba (p. ej. que se ha llegado al límite).
 * Devuelve true si al cerrarla el usuario es Pro.
 */
export function showPro(motivo = '') {
  if (!cap) return Promise.resolve(true);
  return new Promise((resolve) => {
    const modal = $('proModal');
    $('proReason').textContent = motivo;
    $('proReason').hidden = !motivo;
    $('proStatus').textContent = pro ? t('Ya tienes PDF Stroke Pro. ¡Gracias!') : '';
    modal.querySelector('.pro-plans').hidden = pro;
    $('proManage').hidden = !pro;
    $('proPrivacy').hidden = pro || !AdMob;
    modal.hidden = false;
    prices().then((p) => { $('proMonthly').textContent = p.mensual; $('proYearly').textContent = p.anual; });
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
      ['proRestore', attempt(async () => { await Billing.restorePurchases(); await checkPro(); })],
      ['proManage', () => Billing.manageSubscriptions().catch(() => {})],
      ['proPrivacy', () => privacyOptions()],
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
async function prepareAd() {
  if (!AdMob || pro) return;
  try {
    await AdMob.prepareInterstitial({ adId: testAds ? INTERSTICIAL_DE_PRUEBA : ADMOB_INTERSTICIAL, isTesting: testAds });
    adReady = true;
  } catch (err) {
    adReady = false;
    console.warn('Anuncio no disponible', err);
  }
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
    lastAdClosed = Date.now();
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
  await adsStarted;
  if (!adReady) return prepareAd(); // sin anuncio cargado (sin conexión...): no se espera; se prepara el siguiente
  // Recién visto el de apertura (o con otro abierto): no se encadena otro anuncio
  if (showingAd || Date.now() - lastAdClosed < 30000) return;
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
  if (!cap) return;
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
