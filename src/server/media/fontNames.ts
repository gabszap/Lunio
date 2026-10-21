/**
 * Nomes pelos quais uma fonte (TTF, OTF, TTC) pode ser pedida numa legenda ASS: família (ID 1), nome completo (4),
 * PostScript (6) e família tipográfica (16), em todos os idiomas da tabela `name`. Tudo em minúsculas.
 * O player usa isso para carregar só as fontes que a legenda cita, em vez de todas as anexadas ao MKV.
 * Entrada de terceiros: qualquer inconsistência devolve o que já foi lido (nunca lança).
 */

const WANTED_IDS = new Set([1, 4, 6, 16]);
const MAX_RECORDS = 2000;

function u16(buf: Buffer, off: number): number {
  return off >= 0 && off + 2 <= buf.length ? buf.readUInt16BE(off) : -1;
}
function u32(buf: Buffer, off: number): number {
  return off >= 0 && off + 4 <= buf.length ? buf.readUInt32BE(off) : -1;
}

function decode(buf: Buffer, platform: number, encoding: number): string {
  // Windows (3) e Unicode (0): UTF-16 big-endian. Macintosh (1): MacRoman, aqui lido como latin1 (basta para nomes ASCII)
  if (platform === 3 || platform === 0) {
    const even = buf.length - (buf.length % 2);
    let out = '';
    for (let i = 0; i < even; i += 2) out += String.fromCharCode(buf.readUInt16BE(i));
    return out;
  }
  if (platform === 1 && encoding === 0) return buf.toString('latin1');
  return '';
}

function namesOfSfnt(buf: Buffer, base: number, into: Set<string>) {
  const numTables = u16(buf, base + 4);
  if (numTables <= 0 || numTables > 200) return;
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) !== 'name') continue;
    const tableOff = u32(buf, rec + 8);
    const tableLen = u32(buf, rec + 12);
    if (tableOff < 0 || tableLen <= 6 || tableOff + 6 > buf.length) return;
    const count = Math.min(u16(buf, tableOff + 2), MAX_RECORDS);
    const stringsOff = tableOff + u16(buf, tableOff + 4);
    for (let r = 0; r < count; r++) {
      const nr = tableOff + 6 + r * 12;
      const platform = u16(buf, nr);
      const encoding = u16(buf, nr + 2);
      const nameId = u16(buf, nr + 6);
      const length = u16(buf, nr + 8);
      const offset = u16(buf, nr + 10);
      if (nameId < 0 || !WANTED_IDS.has(nameId) || length <= 0) continue;
      const start = stringsOff + offset;
      if (start < 0 || start + length > buf.length) continue;
      const text = decode(buf.subarray(start, start + length), platform, encoding).trim().toLowerCase();
      if (text) into.add(text);
    }
    return;
  }
}

/** Nomes da fonte (de todas as fontes de uma coleção TTC). Vazio se não for TTF/OTF/TTC legível (ex.: WOFF2). */
export function readFontNames(buf: Buffer): string[] {
  const names = new Set<string>();
  try {
    if (buf.length < 12) return [];
    if (buf.toString('latin1', 0, 4) === 'ttcf') {
      const count = Math.min(u32(buf, 8), 64);
      for (let i = 0; i < count; i++) {
        const off = u32(buf, 12 + i * 4);
        if (off >= 0) namesOfSfnt(buf, off, names);
      }
    } else {
      namesOfSfnt(buf, 0, names);
    }
  } catch {
    // arquivo estranho: fica com o que já foi lido
  }
  return [...names];
}
