// Contraseñas de los PDF (sistema de seguridad estándar del formato PDF):
//  - cifrar(): protege un PDF con contraseña para abrirlo (AES de 256 bits, revisión 6, como Acrobat X y posteriores).
//  - descifrar(): con la contraseña (o sin ella, si solo tiene permisos), devuelve el PDF sin cifrar, para poder
//    editarlo, guardarlo o quitarle la contraseña. Admite RC4 de 40/128 bits y AES de 128/256 bits.
// Todo con WebCrypto, en el propio dispositivo.
const {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream, PDFStream, PDFNumber, PDFRef,
  PDFParser, PDFObjectStreamParser, PDFContext,
} = PDFLib;

const subtle = crypto.subtle;
const enc = new TextEncoder();
const PAD = Uint8Array.from([0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);

const cat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const le32 = (n) => Uint8Array.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---------- MD5 y RC4 (los usan los cifrados antiguos; WebCrypto no los tiene) ----------
function md5(data) {
  const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
  const len = data.length, n = ((len + 8) >> 6) + 1;
  const m = new Uint8Array(n * 64);
  m.set(data);
  m[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(m.buffer);
  dv.setUint32(n * 64 - 8, bits >>> 0, true);
  dv.setUint32(n * 64 - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let blk = 0; blk < n; blk++) {
    const M = (i) => dv.getUint32(blk * 64 + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M(g)) >>> 0;
      A = D; D = C; C = B;
      const s = S[(i >> 4) * 4 + (i & 3)];
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  return cat(le32(a0), le32(b0), le32(c0), le32(d0));
}

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

// ---------- AES (WebCrypto) ----------
const aesKey = (k, uses) => subtle.importKey('raw', k, 'AES-CBC', false, uses);
async function aesEncrypt(key, iv, data) { return new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, await aesKey(key, ['encrypt']), data)); }
async function aesDecrypt(key, iv, data) { return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, await aesKey(key, ['decrypt']), data)); }
/** AES-CBC sin relleno (para bloques exactos: claves y /Perms). */
async function aesEncryptRaw(key, iv, data) { return (await aesEncrypt(key, iv, data)).subarray(0, data.length); }
async function aesDecryptRaw(key, iv, data) {
  // WebCrypto exige relleno válido: se añade un bloque cuyo descifrado es justo un relleno completo
  const last = data.subarray(data.length - 16);
  const padBlock = new Uint8Array(16).fill(16).map((v, i) => v ^ last[i]);
  const extra = (await aesEncrypt(key, new Uint8Array(16), padBlock)).subarray(0, 16);
  return aesDecrypt(key, iv, cat(data, extra));
}
const sha = async (alg, data) => new Uint8Array(await subtle.digest(alg, data));

/** Algoritmo 2.B (revisión 6): resumen iterado de la contraseña. */
async function hashR6(pw, salt, udata) {
  let K = await sha('SHA-256', cat(pw, salt, udata));
  for (let i = 0; ; ) {
    const unit = cat(pw, K, udata);
    const K1 = new Uint8Array(unit.length * 64);
    for (let j = 0; j < 64; j++) K1.set(unit, j * unit.length);
    const E = await aesEncryptRaw(K.subarray(0, 16), K.subarray(16, 32), K1);
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += E[j];
    K = await sha(['SHA-256', 'SHA-384', 'SHA-512'][sum % 3], E);
    i++;
    if (i >= 64 && E[E.length - 1] <= i - 32) break;
  }
  return K.subarray(0, 32);
}
const hashR5 = async (pw, salt, udata) => sha('SHA-256', cat(pw, salt, udata));
const pw256 = (s) => enc.encode(s.normalize('NFKC')).subarray(0, 127);

// ---------- Recorrido de objetos ----------
function mapStrings(obj, fn) {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return fn(obj.asBytes());
  if (obj instanceof PDFDict) {
    for (const [k, v] of obj.entries()) {
      const n = mapStrings(v, fn);
      if (n !== v) obj.set(k, n);
    }
  } else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const v = obj.get(i);
      const n = mapStrings(v, fn);
      if (n !== v) obj.set(i, n);
    }
  }
  return obj;
}
const nameIs = (v, n) => v instanceof PDFName && v.asString() === '/' + n;
const bytesOf = (s) => (s instanceof PDFRawStream ? s.contents : s.getContents());

// ---------- Cifrar ----------
/** Protege el PDF: hace falta `contrasena` para abrirlo. Devuelve los bytes cifrados. */
export async function cifrar(bytes, contrasena, propietario = null) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  await doc.flush();
  const ctx = doc.context;
  const key = rand(32);
  const upw = pw256(contrasena);
  const opw = pw256(propietario || toHex(rand(16)));
  // U / UE
  const uvs = rand(8), uks = rand(8);
  const U = cat(await hashR6(upw, uvs, new Uint8Array(0)), uvs, uks);
  const UE = await aesEncryptRaw(await hashR6(upw, uks, new Uint8Array(0)), new Uint8Array(16), key);
  // O / OE
  const ovs = rand(8), oks = rand(8);
  const O = cat(await hashR6(opw, ovs, U), ovs, oks);
  const OE = await aesEncryptRaw(await hashR6(opw, oks, U), new Uint8Array(16), key);
  const P = -4; // todos los permisos (la protección es la contraseña para abrirlo)
  const perms = cat(le32(P), Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x54, 0x61, 0x64, 0x62]), rand(4));
  const Perms = await aesEncryptRaw(key, new Uint8Array(16), perms);

  const encStr = async (b) => {
    const iv = rand(16);
    return PDFHexString.of(toHex(cat(iv, await aesEncrypt(key, iv, b))));
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      if (nameIs(obj.dict.lookup(PDFName.of('Type')), 'XRef')) continue;
      const strs = [];
      mapStrings(obj.dict, (b) => { const h = PDFHexString.of(''); strs.push([h, b]); return h; });
      for (const [h, b] of strs) h.value = (await encStr(b)).value;
      const iv = rand(16);
      const data = cat(iv, await aesEncrypt(key, iv, bytesOf(obj)));
      const dict = obj.dict;
      dict.delete(PDFName.of('Length'));
      ctx.assign(ref, PDFRawStream.of(dict, data));
    } else if (obj instanceof PDFDict || obj instanceof PDFArray || obj instanceof PDFString || obj instanceof PDFHexString) {
      const strs = [];
      const n = mapStrings(obj, (b) => { const h = PDFHexString.of(''); strs.push([h, b]); return h; });
      for (const [h, b] of strs) h.value = (await encStr(b)).value;
      if (n !== obj) ctx.assign(ref, n);
    }
  }
  const encrypt = ctx.obj({
    Filter: 'Standard', V: 5, R: 6, Length: 256, P,
    CF: { StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 } }, StmF: 'StdCF', StrF: 'StdCF',
    O: PDFHexString.of(toHex(O)), U: PDFHexString.of(toHex(U)), OE: PDFHexString.of(toHex(OE)), UE: PDFHexString.of(toHex(UE)),
    Perms: PDFHexString.of(toHex(Perms)),
  });
  ctx.trailerInfo.Encrypt = ctx.register(encrypt);
  const id = toHex(rand(16));
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(id), PDFHexString.of(id)]);
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

// ---------- Descifrar ----------
/** ¿Está cifrado? (mira el principio y el final del archivo, donde están el /Encrypt y el diccionario del trailer) */
export function estaCifrado(bytes) {
  const look = (s, e) => { let r = ''; for (let i = s; i < e; i++) r += String.fromCharCode(bytes[i]); return r; };
  const n = bytes.length;
  return /\/Encrypt\s*\d+\s+\d+\s+R|\/Encrypt\s*<</.test(look(0, Math.min(n, 65536)) + look(Math.max(0, n - 65536), n));
}

/** Carga con pdf-lib; mientras, las secuencias de objetos (ObjStm) se descifran antes de leerlas. */
async function cargar(bytes, decryptStream) {
  const origHeader = PDFParser.prototype.parseIndirectObjectHeader;
  const origFor = PDFObjectStreamParser.forStream;
  const origAssign = PDFContext.prototype.assign;
  let lastRef = null, inObjStm = false;
  const fromObjStm = new Set();
  PDFParser.prototype.parseIndirectObjectHeader = function (...a) { lastRef = origHeader.apply(this, a); return lastRef; };
  PDFObjectStreamParser.forStream = (raw, wait) => {
    const ref = lastRef;
    return {
      parseIntoContext: async () => {
        if (!decryptStream) return; // primera pasada: solo hace falta el diccionario /Encrypt
        const dec = await decryptStream(raw.contents, ref);
        inObjStm = true;
        try { await origFor.call(PDFObjectStreamParser, PDFRawStream.of(raw.dict, dec), wait).parseIntoContext(); } finally { inObjStm = false; }
      },
    };
  };
  PDFContext.prototype.assign = function (ref, obj) { if (inObjStm) fromObjStm.add(ref.toString()); return origAssign.call(this, ref, obj); };
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return { doc, fromObjStm };
  } finally {
    PDFParser.prototype.parseIndirectObjectHeader = origHeader;
    PDFObjectStreamParser.forStream = origFor;
    PDFContext.prototype.assign = origAssign;
  }
}

const numOf = (v) => (v instanceof PDFNumber ? v.asNumber() : undefined);
const strBytes = (v) => (v instanceof PDFString || v instanceof PDFHexString ? v.asBytes() : null);

/** Clave del archivo a partir de la contraseña (de usuario o de propietario). null si no es correcta. */
async function claveArchivo(E, id0, password) {
  const R = numOf(E.lookup(PDFName.of('R'))) ?? 2;
  const O = strBytes(E.lookup(PDFName.of('O'))), U = strBytes(E.lookup(PDFName.of('U')));
  if (!O || !U) throw new Error('Cifrado no soportado');
  if (R >= 5) {
    const pw = pw256(password);
    const H = R === 5 ? hashR5 : hashR6;
    const OE = strBytes(E.lookup(PDFName.of('OE'))), UE = strBytes(E.lookup(PDFName.of('UE')));
    const U48 = U.subarray(0, 48);
    if (eq(await H(pw, O.subarray(32, 40), U48), O.subarray(0, 32))) return aesDecryptRaw(await H(pw, O.subarray(40, 48), U48), new Uint8Array(16), OE);
    if (eq(await H(pw, U.subarray(32, 40), new Uint8Array(0)), U.subarray(0, 32))) return aesDecryptRaw(await H(pw, U.subarray(40, 48), new Uint8Array(0)), new Uint8Array(16), UE);
    return null;
  }
  const P = numOf(E.lookup(PDFName.of('P'))) ?? 0;
  const len = R === 2 ? 5 : (numOf(E.lookup(PDFName.of('Length'))) ?? 40) / 8;
  const encMeta = E.lookup(PDFName.of('EncryptMetadata'))?.toString() !== 'false';
  const padded = (b) => cat(b.subarray(0, 32), PAD.subarray(0, Math.max(0, 32 - b.length)));
  const keyFor = (pwPadded) => {
    let h = md5(cat(pwPadded, O.subarray(0, 32), le32(P), id0, R >= 4 && !encMeta ? Uint8Array.from([255, 255, 255, 255]) : new Uint8Array(0)));
    if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, len));
    return h.subarray(0, len);
  };
  const userOk = (key) => {
    if (R === 2) return eq(rc4(key, PAD), U.subarray(0, 32));
    let x = rc4(key, md5(cat(PAD, id0)));
    for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
    return eq(x.subarray(0, 16), U.subarray(0, 16));
  };
  const pw = Uint8Array.from(password, (c) => c.charCodeAt(0) & 255);
  // ¿Contraseña de usuario?
  let key = keyFor(padded(pw));
  if (userOk(key)) return key;
  // ¿De propietario? Con ella se obtiene la de usuario
  let h = md5(padded(pw));
  if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h);
  const okey = h.subarray(0, len);
  let upw;
  if (R === 2) upw = rc4(okey, O.subarray(0, 32));
  else { upw = O.subarray(0, 32); for (let i = 19; i >= 0; i--) upw = rc4(okey.map((b) => b ^ i), upw); }
  key = keyFor(upw);
  return userOk(key) ? key : null;
}

/**
 * Descifra el PDF con la contraseña. Devuelve los bytes sin cifrar; lanza un error si la contraseña no es correcta
 * o si el cifrado no es el estándar (p. ej. con certificados).
 */
export async function descifrar(bytes, password = '') {
  const first = await cargar(bytes, null);
  const encRef = first.doc.context.trailerInfo.Encrypt;
  const E = encRef instanceof PDFRef ? first.doc.context.lookup(encRef) : encRef;
  if (!(E instanceof PDFDict)) return bytes;
  if (!nameIs(E.lookup(PDFName.of('Filter')), 'Standard')) throw new Error('Cifrado no soportado');
  const idArr = first.doc.context.trailerInfo.ID;
  const ids = idArr instanceof PDFArray ? idArr : (idArr instanceof PDFRef ? first.doc.context.lookup(idArr) : null);
  const id0 = (ids instanceof PDFArray && strBytes(ids.lookup(0))) || new Uint8Array(0);
  const key = await claveArchivo(E, id0, password);
  if (!key) throw new Error('Contraseña incorrecta');
  const V = numOf(E.lookup(PDFName.of('V'))) ?? 0;
  const R = numOf(E.lookup(PDFName.of('R'))) ?? 2;
  // Método de cada tipo de dato (filtros de cifrado de V4/V5)
  const method = (which) => {
    if (V < 4) return 'RC4';
    const name = E.lookup(PDFName.of(which));
    if (!name || nameIs(name, 'Identity')) return name ? 'none' : 'none';
    const cf = E.lookup(PDFName.of('CF'));
    const f = cf instanceof PDFDict ? cf.lookup(name) : null;
    const cfm = f instanceof PDFDict ? f.lookup(PDFName.of('CFM')) : null;
    if (nameIs(cfm, 'AESV2')) return 'AES';
    if (nameIs(cfm, 'AESV3')) return 'AES';
    if (nameIs(cfm, 'V2')) return 'RC4';
    return 'none';
  };
  const stmM = method('StmF'), strM = method('StrF');
  const encMeta = E.lookup(PDFName.of('EncryptMetadata'))?.toString() !== 'false';
  const objKey = (ref, aes) => {
    if (R >= 5) return key;
    const n = ref.objectNumber, g = ref.generationNumber;
    const h = md5(cat(key, Uint8Array.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255]), aes ? Uint8Array.from([0x73, 0x41, 0x6C, 0x54]) : new Uint8Array(0)));
    return h.subarray(0, Math.min(key.length + 5, 16));
  };
  const dec = async (data, ref, m) => {
    if (m === 'none' || !data.length) return data;
    const k = objKey(ref, m === 'AES');
    if (m === 'RC4') return rc4(k, data);
    if (data.length < 32 || data.length % 16) return data.length > 16 ? new Uint8Array(0) : data;
    try { return await aesDecrypt(k, data.subarray(0, 16), data.subarray(16)); } catch { return aesDecryptRaw(k, data.subarray(0, 16), data.subarray(16)); }
  };

  const { doc, fromObjStm } = await cargar(bytes, (data, ref) => dec(data, ref, stmM));
  const ctx = doc.context;
  const encKey = encRef instanceof PDFRef ? encRef.toString() : null;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const k = ref.toString();
    if (k === encKey) continue;
    const plainStrings = fromObjStm.has(k); // dentro de una secuencia de objetos no se cifran aparte
    const fixStrings = async (o) => {
      if (plainStrings || strM === 'none') return o;
      if (o instanceof PDFDict && nameIs(o.lookup(PDFName.of('Type')), 'Sig')) return o; // /Contents de las firmas
      const strs = [];
      const n = mapStrings(o, (b) => { const h = PDFHexString.of(''); strs.push([h, b]); return h; });
      for (const [h, b] of strs) h.value = toHex(await dec(b, ref, strM));
      return n;
    };
    if (obj instanceof PDFRawStream) {
      await fixStrings(obj.dict);
      const isMeta = nameIs(obj.dict.lookup(PDFName.of('Type')), 'Metadata');
      if (nameIs(obj.dict.lookup(PDFName.of('Type')), 'XRef') || (isMeta && !encMeta)) continue;
      const d = await dec(obj.contents, ref, stmM);
      ctx.assign(ref, PDFRawStream.of(obj.dict, d));
    } else {
      const n = await fixStrings(obj);
      if (n !== obj) ctx.assign(ref, n);
    }
  }
  ctx.trailerInfo.Encrypt = undefined;
  if (encRef instanceof PDFRef) ctx.delete(encRef);
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}
