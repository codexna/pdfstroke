// Texto compatible con las fuentes estándar del PDF (codificación WinAnsi). Se usa igual al medir en pantalla
// y al escribir el PDF, para que ambos coincidan.

// Caracteres de WinAnsi fuera de Latin-1
const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

const MAP = {
  '−': '-', '‐': '-', '‑': '-', '⁃': '-',
  'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl',
  '\t': ' ', ' ': ' ', ' ': ' ',
};

export function isWinAnsi(ch) {
  const c = ch.codePointAt(0);
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.has(ch);
}

/**
 * Convierte un texto a caracteres que las fuentes estándar pueden escribir: compone los acentos (NFC), pasa los
 * espacios especiales a espacios normales, quita los caracteres invisibles y el guion blando, y cambia por "?"
 * lo que no se puede representar (llamando a onReplace por cada uno).
 */
export function toPdfText(s, onReplace) {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    if (MAP[ch] !== undefined) { out += MAP[ch]; continue; }
    const c = ch.codePointAt(0);
    if ((c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000) { out += ' '; continue; }
    if ((c >= 0x200b && c <= 0x200d) || c === 0x2060 || c === 0xfeff || c === 0xad) continue;
    if (isWinAnsi(ch)) { out += ch; continue; }
    out += '?';
    onReplace?.();
  }
  return out;
}
