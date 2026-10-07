import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

/** Pastas de cache em disco (legendas e fontes extraídas). Limitadas por `cleanup.ts` (MAX_CACHE_GB). */
export const SUB_CACHE_DIR = path.resolve(config.rootDir, '.cache', 'subtitles');
export const AUDIO_CACHE_DIR = path.resolve(config.rootDir, '.cache', 'audio');
export const FONT_CACHE_DIR = path.resolve(config.rootDir, '.cache', 'fonts');

for (const dir of [SUB_CACHE_DIR, AUDIO_CACHE_DIR, FONT_CACHE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
