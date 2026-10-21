import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FONT_CACHE_DIR } from './paths';
import { readFontNames } from './fontNames';

/**
 * Índice das fontes extraídas de uma mídia (`fonts/<hash>/`): para cada `f<índice>.<ext>` guarda os nomes pelos quais a
 * legenda pode pedi-la (`names.json`) e deduplica por conteúdo. Os episódios de um mesmo grupo repetem as mesmas ~24
 * fontes; cada pasta de mídia as guarda como hardlink de um único arquivo em `fonts/_shared/<sha256>.<ext>`.
 * Hardlink (não cópia nem referência): a rota que serve a fonte continua lendo `f<índice>.<ext>` como sempre, e apagar
 * a pasta de uma mídia nunca deixa uma referência pendurada.
 */

export const SHARED_DIR_NAME = '_shared';
const NAMES_FILE = 'names.json';

export interface FontNamesEntry {
  names: string[];
  ext: string;
}
export type FontNamesIndex = Record<string, FontNamesEntry>;

const FONT_FILE = /^f(\d{1,4})\.(ttf|otf|woff2|ttc)$/i;

export function readNamesIndex(targetDir: string): FontNamesIndex {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(targetDir, NAMES_FILE), 'utf8')) as FontNamesIndex;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** Troca `file` por um hardlink do arquivo compartilhado de mesmo conteúdo (criando-o se for o primeiro). */
function dedupeIntoShared(file: string, sha: string, ext: string) {
  const sharedDir = path.join(FONT_CACHE_DIR, SHARED_DIR_NAME);
  const shared = path.join(sharedDir, `${sha}.${ext}`);
  try {
    fs.mkdirSync(sharedDir, { recursive: true });
    if (!fs.existsSync(shared)) {
      fs.linkSync(file, shared);
      return;
    }
    // Já é o mesmo arquivo no disco (extração repetida): nada a fazer
    if (fs.statSync(shared).ino === fs.statSync(file).ino) return;
    const tmp = `${file}.lnk`;
    fs.linkSync(shared, tmp);
    fs.renameSync(tmp, file);
  } catch {
    // sistema de arquivos sem hardlink ou corrida com a limpeza: a fonte fica como cópia própria
  }
}

/**
 * Indexa as fontes que ainda não estão em `names.json` (nomes) e as deduplica. Devolve o índice completo.
 * Chamada depois de cada extração; fontes já indexadas não são lidas de novo.
 */
export function indexFonts(targetDir: string): FontNamesIndex {
  const index = readNamesIndex(targetDir);
  let changed = false;
  let files: string[] = [];
  try {
    files = fs.readdirSync(targetDir);
  } catch {
    return index;
  }
  for (const name of files) {
    const m = FONT_FILE.exec(name);
    if (!m || index[m[1]]) continue;
    const file = path.join(targetDir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size <= 100) continue;
      const buf = fs.readFileSync(file);
      const ext = m[2].toLowerCase();
      index[m[1]] = { names: readFontNames(buf), ext };
      changed = true;
      dedupeIntoShared(file, crypto.createHash('sha256').update(buf).digest('hex'), ext);
    } catch {
      // arquivo sumiu ou ilegível: fica sem entrada (o player carrega essa fonte por garantia)
    }
  }
  if (changed) {
    try {
      const tmp = path.join(targetDir, `${NAMES_FILE}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(index));
      fs.renameSync(tmp, path.join(targetDir, NAMES_FILE));
    } catch {
      // sem o índice o player carrega todas as fontes (como antes)
    }
  }
  return index;
}
