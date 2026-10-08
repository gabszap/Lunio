import path from 'node:path';
import { config } from '../config';

export const UPLOAD_DIR = path.resolve(config.rootDir, '.uploads');
export const UPLOAD_META = '.meta.json';

export const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
};

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Nome de arquivo seguro: sem caminho, sem ponto no início, sem nomes reservados do Windows. Idempotente. */
export function safeFileName(name: string): string {
  let base = path
    .basename((name || '').replace(/\\/g, '/'))
    .replace(/[^\w.\-()[\] ]+/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 180)
    .trim();
  if (!base || WINDOWS_RESERVED.test(base)) base = `video${base ? `_${base}` : ''}`;
  return base;
}
