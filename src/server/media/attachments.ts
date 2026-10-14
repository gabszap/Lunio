import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { spawnLimited } from '../limits';
import { getTools, killTree } from '../tools';

export interface AttachmentEntry {
  ordinal: number;
  filename: string;
  size: number;
}

/**
 * Lê só o bloco Attachments do MKV (mkv_extractor --attachments) e grava cada anexo em `dir/a<ordem>.bin`.
 * Uma requisição ao CDN, em vez de o FFmpeg percorrer o arquivo inteiro atrás das fontes. Rejeita quando o arquivo
 * não tem SeekHead para Attachments ou o Python não está disponível: quem chama cai no FFmpeg.
 */
export function readAttachments(streamUrl: string, dir: string): Promise<AttachmentEntry[]> {
  const py = getTools().python;
  if (!py.found) return Promise.reject(new Error('Python 3.10+ não encontrado.'));
  return new Promise((resolve, reject) => {
    const proc = spawnLimited(py.command, [...py.args, '-u', '-m', 'mkv_extractor', streamUrl, '--attachments', dir], {
      cwd: config.rootDir,
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    if (!proc) {
      const busy: any = new Error('Servidor ocupado (limite de processos).');
      busy.code = 'busy';
      reject(busy);
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => killTree(proc), 60_000);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`mkv_extractor --attachments saiu com ${code}: ${err.trim().slice(-200)}`));
      try {
        resolve(JSON.parse(out) as AttachmentEntry[]);
      } catch {
        reject(new Error('Resposta inválida do mkv_extractor --attachments.'));
      }
    });
  });
}

/**
 * Casa os índices de stream do FFmpeg (o que o player pede) com a ordem dos anexos no MKV. Os anexos são os últimos
 * streams, em ordem, então ordem = índice - menor índice de anexo. Sem a lista do /api/tracks, só o nome decide (e só
 * quando ele é único). O nome do anexo confirma o casamento; se não bater, o índice fica de fora e o FFmpeg cobre.
 */
export function mapAttachmentOrdinals(
  wanted: Map<string, string>,
  knownFontIndexes: number[],
  entries: AttachmentEntry[]
): Map<string, number> {
  const mapped = new Map<string, number>();
  const base = knownFontIndexes.length ? Math.min(...knownFontIndexes) : null;
  for (const [idx, name] of wanted) {
    let ordinal: number | null = null;
    if (base !== null) {
      const guess = Number(idx) - base;
      if (guess >= 0 && guess < entries.length && (!name || entries[guess].filename === name)) ordinal = guess;
    } else if (name) {
      const same = entries.filter((e) => e.filename === name);
      if (same.length === 1) ordinal = same[0].ordinal;
    }
    if (ordinal !== null) mapped.set(idx, ordinal);
  }
  return mapped;
}

/** Move `a<ordem>.bin` para o nome final escolhido pelo servidor e apaga o resto. */
export function placeAttachments(dir: string, entries: AttachmentEntry[], finalNames: Map<number, string>) {
  for (const e of entries) {
    const from = path.join(dir, `a${e.ordinal}.bin`);
    const to = finalNames.get(e.ordinal);
    try {
      if (to) fs.renameSync(from, path.join(dir, to));
      else fs.unlinkSync(from);
    } catch {
      // arquivo ausente ou já movido: o FFmpeg cobre o que faltar
    }
  }
}
