import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateAssDocument } from '../../lib/subtitleFormats';
import { touchCacheFile } from '../cleanup';
import { SUB_CACHE_DIR } from './paths';

export interface CachedSubtitleV2 {
  version: 2;
  format: 'ass';
  mediaKey: string;
  track: string;
  sha256: string;
  events: number;
  content: string;
  producer: 'native-ass' | 'native-srt' | 'ffmpeg';
}

const producers = new Set(['native-ass', 'native-srt', 'ffmpeg']);
const digest = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

export function subtitleCachePath(mediaKey: string, track: string): string {
  if (!/^[a-f0-9]+$/i.test(mediaKey) || !/^\d{1,4}$/.test(track)) throw new Error('Identidade de cache inválida.');
  return path.join(SUB_CACHE_DIR, `${mediaKey}_s${track}_v2.json`);
}

/** A miss never destroys an entry: another publisher may be replacing it. */
export function readCachedSubtitle(mediaKey: string, track: string): string | null {
  try {
    const file = subtitleCachePath(mediaKey, track);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    const entry = JSON.parse(text) as CachedSubtitleV2;
    if (!entry || entry.version !== 2 || entry.format !== 'ass' || entry.mediaKey !== mediaKey || entry.track !== track ||
        !producers.has(entry.producer) || typeof entry.content !== 'string' || entry.sha256 !== digest(entry.content)) return null;
    const validation = validateAssDocument(entry.content);
    if (!validation.valid || entry.events !== validation.events) return null;
    touchCacheFile(file);
    return entry.content;
  } catch {
    return null;
  }
}

export function writeCachedSubtitle(mediaKey: string, track: string, content: string, producer: CachedSubtitleV2['producer']): void {
  const validation = validateAssDocument(content);
  if (!validation.valid || !producers.has(producer)) {
    throw Object.assign(new Error('Documento ASS inválido para publicação.'), { code: 'SUBTITLE_INVALID' });
  }
  const file = subtitleCachePath(mediaKey, track);
  const entry: CachedSubtitleV2 = { version: 2, format: 'ass', mediaKey, track, sha256: digest(content), events: validation.events, content, producer };
  fs.mkdirSync(SUB_CACHE_DIR, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(entry), { encoding: 'utf8', flag: 'wx' });
    // Same-directory rename replaces the envelope in one operation. Never unlink the previous version.
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* published, or failed before creation */ }
  }
}
