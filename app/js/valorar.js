// Pedir una valoración en Google Play (ventana oficial de Google, sin salir de la app), solo cuando tiene sentido:
// tras varios guardados con éxito, después de unos días de uso y como mucho una vez cada tres meses. Google decide
// además si la muestra (tiene su propio límite). Solo en la app de Android.
const plugin = window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.Valorar : null;
const KEY = 'editorpdf.valorar';
const DIA = 24 * 3600 * 1000;
const EXITOS = 3; // guardados o conversiones con éxito
const ESPERA = 2 * DIA; // desde el primer uso
const CADA = 90 * DIA; // entre peticiones

const leer = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
const guardar = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };

// Primer uso (para no pedirlo el primer día)
(() => { const v = leer(); if (!v.primera) guardar({ ...v, primera: Date.now() }); })();

/** Un archivo guardado, compartido o convertido con éxito. */
export function exito() {
  const v = leer();
  guardar({ ...v, exitos: (v.exitos || 0) + 1 });
}

/** Si toca, abre la ventana de valoración de Google Play (se llama al cerrar el aviso de «Archivo guardado»). */
export function quizaPedirValoracion() {
  if (!plugin) return;
  const v = leer(), ahora = Date.now();
  if ((v.exitos || 0) < EXITOS || ahora - (v.primera || ahora) < ESPERA || (v.ultima && ahora - v.ultima < CADA)) return;
  guardar({ ...v, ultima: ahora });
  setTimeout(() => plugin.pedir().catch(() => {}), 600);
}
