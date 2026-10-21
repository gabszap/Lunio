/**
 * Quais fontes uma legenda ASS usa: o `Fontname` de cada `Style` e os `\fn` dentro dos eventos. O player carrega só as
 * fontes anexadas ao MKV que casam com esses nomes (ver `/api/fontmap`), em vez das ~24 (~46 MB) de cada release.
 */

/** "@Fonte" é a variante vertical da fonte; para o nome do arquivo vale o mesmo nome sem o "@". */
const normalize = (name: string) => name.trim().replace(/^@/, '').trim().toLowerCase();

export function collectAssFontNames(ass: string): Set<string> {
  const used = new Set<string>();
  const add = (raw: string) => {
    const n = normalize(raw);
    if (n) used.add(n);
  };

  // Styles: a coluna do Fontname vem da linha "Format:" da seção de estilos
  let inStyles = false;
  let fontColumn = -1;
  for (const rawLine of ass.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inStyles = /^\[v4\+? styles\]$/i.test(line);
      fontColumn = -1;
      continue;
    }
    if (!inStyles) continue;
    if (/^format\s*:/i.test(line)) {
      fontColumn = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .findIndex((c) => c.trim().toLowerCase() === 'fontname');
    } else if (/^style\s*:/i.test(line) && fontColumn >= 0) {
      const cols = line.slice(line.indexOf(':') + 1).split(',');
      if (cols[fontColumn] !== undefined) add(cols[fontColumn]);
    }
  }

  // Trocas de fonte no meio do texto: {\fnArial}, {\fn@Fonte}; o nome vai até a próxima barra ou chave
  for (const m of ass.matchAll(/\\fn([^\\}]+)/g)) add(m[1]);
  return used;
}

export interface FontRef {
  index: number;
  url?: string;
}

/**
 * Das fontes anexadas, as que a legenda usa. Sem o mapa de nomes (rota indisponível, faixas ainda não listadas) ou para
 * uma fonte de nomes desconhecidos, carrega a fonte por garantia: nunca fica com menos do que antes por falta de dados.
 */
export function selectFontsToLoad(
  fonts: FontRef[],
  map: { complete: boolean; fonts: Record<string, string[] | null> } | null,
  used: Set<string>
): { urls: string[]; skipped: number } {
  const all = fonts.filter((f) => f.url);
  if (!map || !map.complete) return { urls: all.map((f) => f.url as string), skipped: 0 };

  const urls: string[] = [];
  for (const f of all) {
    const names = map.fonts[String(f.index)];
    const unknown = !names || names.length === 0;
    if (unknown || names.some((n) => used.has(n))) urls.push(f.url as string);
  }
  return { urls, skipped: all.length - urls.length };
}
