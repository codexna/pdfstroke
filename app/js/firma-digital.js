// Firma digital con certificado (como Adobe Acrobat y las apps de firma): el PDF se firma con un certificado
// personal en formato PKCS#12 (.p12 / .pfx; p. ej. el de la FNMT o el exportado del navegador) y la firma
// (PKCS#7 «adbe.pkcs7.detached», con SHA-256) queda dentro del PDF. Cualquier lector (Adobe, el visor de Windows,
// Autofirma, VALIDe…) puede comprobar quién firmó y que el documento no se ha modificado después.
// Todo se hace en el dispositivo: el certificado y su contraseña no se envían a ningún sitio ni se guardan.
import { t } from './i18n.js';

const RESERVA = 16384; // bytes reservados para la firma PKCS#7 (con la cadena de certificados)
const MARCA = '**********'; // relleno provisional del /ByteRange (se sustituye por los números de verdad)

let forgeListo = null;
function cargarForge() {
  if (window.forge) return Promise.resolve(window.forge);
  forgeListo ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/forge.min.js', import.meta.url).href;
    s.onload = () => res(window.forge);
    s.onerror = () => { forgeListo = null; rej(new Error(t('No se pudo cargar el módulo de firma.'))); };
    document.head.appendChild(s);
  });
  return forgeListo;
}

// Bytes <-> «cadena binaria» (lo que usa forge)
function aBinario(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

/** Valor legible de un campo del titular del certificado (CN, O…), en UTF-8 si hace falta. */
function campo(cert, nombre) {
  const f = cert.subject.getField(nombre);
  if (!f) return '';
  try { return window.forge.util.decodeUtf8(f.value); } catch { return f.value; }
}

/**
 * Abre el certificado .p12/.pfx con su contraseña. Devuelve la clave privada, el certificado del firmante, la
 * cadena de certificados y los datos para mostrar (nombre, emisor, validez).
 */
export async function abrirCertificado(p12Bytes, password) {
  const forge = await cargarForge();
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(aBinario(p12Bytes));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/password|mac|Invalid|decrypt/i.test(msg)) throw new Error(t('La contraseña del certificado no es correcta.'));
    throw new Error(t('El archivo no es un certificado .p12 / .pfx válido.'));
  }
  const oids = forge.pki.oids;
  const bolsa = (tipo) => p12.getBags({ bagType: tipo })[tipo] || [];
  const claves = [...bolsa(oids.pkcs8ShroudedKeyBag), ...bolsa(oids.keyBag)].map((b) => b.key).filter(Boolean);
  const certs = bolsa(oids.certBag).map((b) => b.cert).filter(Boolean);
  if (!claves.length || !certs.length) {
    if (!claves.length && bolsa(oids.pkcs8ShroudedKeyBag).length) throw new Error(t('Este certificado usa un tipo de clave que no se puede usar para firmar aquí (solo RSA).'));
    throw new Error(t('El certificado no incluye la clave privada. Expórtalo de nuevo incluyendo la clave privada.'));
  }
  // El certificado del firmante es el de la misma clave pública que la clave privada
  const key = claves[0];
  const cert = certs.find((c) => c.publicKey?.n && key.n && c.publicKey.n.equals(key.n)) || certs[0];
  const ahora = new Date();
  return {
    key, cert, certs,
    nombre: campo(cert, 'CN') || campo(cert, 'O') || t('(sin nombre)'),
    emisor: (() => { const f = cert.issuer.getField('CN') || cert.issuer.getField('O'); try { return f ? forge.util.decodeUtf8(f.value) : ''; } catch { return f?.value || ''; } })(),
    desde: cert.validity.notBefore,
    hasta: cert.validity.notAfter,
    caducado: ahora > cert.validity.notAfter || ahora < cert.validity.notBefore,
  };
}

/** Texto que admite la fuente estándar (Helvetica, WinAnsi): lo que no, se cambia por «?». */
const winAnsi = (s) => s.replace(/[^\x20-\x7e\xa0-\xff€]/g, '?');

/**
 * Firma el PDF. `firma` es lo que devuelve abrirCertificado(). Opciones: motivo, lugar y `visible` (un sello con el
 * nombre y la fecha abajo a la derecha de la última página). Devuelve los bytes del PDF firmado.
 */
export async function firmarPdf(pdfBytes, firma, { motivo = '', lugar = '', visible = true } = {}) {
  const forge = await cargarForge();
  const { PDFDocument, PDFName, PDFString, PDFHexString, PDFNumber, PDFArray, PDFDict, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const ctx = doc.context;
  const pages = doc.getPages();
  const page = pages[pages.length - 1];
  const fecha = new Date();

  // Sello visible (opcional)
  let rect = [0, 0, 0, 0];
  if (visible) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const caja = page.getCropBox();
    const lineas = [
      { txt: winAnsi(t('Firmado digitalmente por')), f: font, s: 7 },
      { txt: winAnsi(firma.nombre), f: bold, s: 8.5 },
      { txt: winAnsi(t('Fecha: {fecha}', { fecha: fecha.toLocaleString() })), f: font, s: 7 },
    ];
    if (motivo) lineas.push({ txt: winAnsi(t('Motivo: {motivo}', { motivo })), f: font, s: 7 });
    const ancho = Math.min(caja.width - 24, Math.max(...lineas.map((l) => l.f.widthOfTextAtSize(l.txt, l.s))) + 16);
    const alto = lineas.reduce((a, l) => a + l.s + 3, 0) + 10;
    const x = caja.x + caja.width - ancho - 18, y = caja.y + 18;
    page.drawRectangle({ x, y, width: ancho, height: alto, color: rgb(0.96, 0.97, 1), borderColor: rgb(0.11, 0.25, 0.73), borderWidth: 0.8, opacity: 0.92 });
    let yy = y + alto - 6;
    for (const l of lineas) {
      yy -= l.s + 1;
      page.drawText(l.txt, { x: x + 8, y: yy, size: l.s, font: l.f, color: rgb(0.11, 0.18, 0.45) });
      yy -= 2;
    }
    rect = [x, y, x + ancho, y + alto];
  }

  // Diccionario de la firma, con huecos para el /ByteRange y el /Contents que se rellenan después
  const byteRange = PDFArray.withContext(ctx);
  byteRange.push(PDFNumber.of(0));
  byteRange.push(PDFName.of(MARCA));
  byteRange.push(PDFName.of(MARCA));
  byteRange.push(PDFName.of(MARCA));
  const sig = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: byteRange,
    Contents: PDFHexString.of('0'.repeat(RESERVA * 2)),
    M: PDFString.fromDate(fecha),
    Name: PDFHexString.fromText(firma.nombre),
  });
  if (motivo) sig.set(PDFName.of('Reason'), PDFHexString.fromText(motivo));
  if (lugar) sig.set(PDFName.of('Location'), PDFHexString.fromText(lugar));
  const sigRef = ctx.register(sig);

  // Campo de firma (widget) en la última página
  const widget = ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', F: 4,
    Rect: rect, V: sigRef, P: page.ref,
    T: PDFString.of('Firma' + Date.now().toString(36)),
  });
  const widgetRef = ctx.register(widget);
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (annots instanceof PDFArray) annots.push(widgetRef);
  else page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));

  let acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acro) {
    acro = ctx.obj({ Fields: [] });
    doc.catalog.set(PDFName.of('AcroForm'), ctx.register(acro));
  }
  const campos = acro.lookup(PDFName.of('Fields'));
  if (campos instanceof PDFArray) campos.push(widgetRef);
  else acro.set(PDFName.of('Fields'), ctx.obj([widgetRef]));
  acro.set(PDFName.of('SigFlags'), PDFNumber.of(3));

  const bytes = await doc.save({ useObjectStreams: false });

  // Huecos: /Contents <000…> y /ByteRange [0 /** /** /**]
  const txt = aBinario(bytes);
  const hueco = '<' + '0'.repeat(RESERVA * 2) + '>';
  const ini = txt.indexOf(hueco);
  const br = /\/ByteRange\s*\[\s*0\s+\/\*{10}\s+\/\*{10}\s+\/\*{10}\s*\]/.exec(txt);
  if (ini < 0 || !br || txt.indexOf(hueco, ini + 1) >= 0) throw new Error(t('No se pudo preparar la firma en este PDF.'));
  const fin = ini + hueco.length;
  const rango = [0, ini, fin, bytes.length - fin];
  const brTxt = `/ByteRange [${rango.join(' ')}]`;
  if (brTxt.length > br[0].length) throw new Error(t('No se pudo preparar la firma en este PDF.'));
  const out = new Uint8Array(bytes);
  const brPadded = brTxt + ' '.repeat(br[0].length - brTxt.length);
  for (let i = 0; i < brPadded.length; i++) out[br.index + i] = brPadded.charCodeAt(i);

  // Firma PKCS#7 separada (SHA-256) de todo el archivo menos el hueco de /Contents
  const datos = aBinario(out.subarray(0, ini)) + aBinario(out.subarray(fin));
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(datos);
  for (const c of firma.certs) p7.addCertificate(c);
  const oids = forge.pki.oids;
  p7.addSigner({
    key: firma.key,
    certificate: firma.cert,
    digestAlgorithm: oids.sha256,
    authenticatedAttributes: [
      { type: oids.contentType, value: oids.data },
      { type: oids.messageDigest },
      { type: oids.signingTime, value: fecha },
    ],
  });
  p7.sign({ detached: true });
  const asn = p7.toAsn1();
  // forge vuelve a codificar el emisor del certificado y estropea los nombres con acentos o «ñ» (UTF-8 dos veces):
  // entonces los lectores no encuentran el certificado del firmante. Se pone el emisor tal cual viene en el certificado.
  const tbs = firma.cert.tbsCertificate?.value;
  if (tbs) {
    const off = tbs[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
    const signedData = asn.value[1].value[0].value;
    const signerInfo = signedData[signedData.length - 1].value[0];
    signerInfo.value[1].value[0] = tbs[off + 2];
  }
  const der = forge.asn1.toDer(asn).getBytes();
  if (der.length > RESERVA) throw new Error(t('La firma no cabe en el espacio reservado (el certificado es demasiado grande).'));
  const hex = forge.util.bytesToHex(der).toUpperCase().padEnd(RESERVA * 2, '0');
  for (let i = 0; i < hex.length; i++) out[ini + 1 + i] = hex.charCodeAt(i);
  return out;
}
