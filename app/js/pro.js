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
// Enlaces de compra (checkout) de cada plan del producto «PDF Stroke Pro (web)» y número de la tienda (para comprobar
// que la licencia es de esta tienda). Un plan con el enlace vacío no se muestra; sin ninguno, en la web solo se
// ofrece la app de Android. Los precios de la web (con IVA) son distintos de los de Google Play.
const WEB_COMPRA = {
  mensual: 'https://pdfstroke.lemonsqueezy.com/checkout/buy/a0844078-9135-4f03-9995-b0e8e0cfdc93',
  anual: 'https://pdfstroke.lemonsqueezy.com/checkout/buy/2dc5a3ee-8b42-4dc5-96af-dc0ebefe07b2',
  vida: 'https://pdfstroke.lemonsqueezy.com/checkout/buy/8dd27663-a8db-44c8-819f-4c273fa5ad33',
};
const WEB_PRECIOS = { mensual: '1,99 €', anual: '6,99 €', vida: '12,99 €' };
const WEB_TIENDA = 520600;
const hayCompraWeb = () => Object.values(WEB_COMPRA).some(Boolean);
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
    $('proRestoreHint').hidden = true;
    $('proWeb').hidden = webPro;
    $('proWebBuy').hidden = !hayCompraWeb();
    $('proWebKey').hidden = !hayCompraWeb();
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
    const close = () => {
      modal.hidden = true;
      modal.classList.remove('web');
      $('proWeb').hidden = true;
      $('proRestore').hidden = false;
      for (const [id, fn] of handlers) $(id).removeEventListener('click', fn);
      resolve(webPro);
    };
    const handlers = [
      ['proWebBuy', (e) => { const b = e.target.closest('[data-plan]'); if (b && WEB_COMPRA[b.dataset.plan]) window.open(WEB_COMPRA[b.dataset.plan], '_blank', 'noopener'); }],
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
