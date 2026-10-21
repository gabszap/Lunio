import dotenv from 'dotenv';
import crypto from 'node:crypto';
import path from 'node:path';

// O Vite só expõe variáveis VITE_* ao código do cliente; o servidor lê o `.env` por conta própria.
// Variáveis já definidas no ambiente (systemd, Docker…) têm prioridade sobre o arquivo.
dotenv.config({ quiet: true });

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function flag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test((process.env[name] || '').trim());
}

const GB = 1024 ** 3;

function parseOrigins(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export const config = {
  /** Raiz do projeto: onde ficam `.env`, `.uploads/`, `.cache/`, `dist/` e `mkv_extractor/`. Rode sempre a partir dela. */
  rootDir: path.resolve(process.cwd()),
  /** Porta e endereço do servidor de produção (`npm run serve`). */
  port: num('PORT', 3000),
  host: process.env.HOST?.trim() || '0.0.0.0',
  /** Origens extras (além da própria) autorizadas a chamar a API e abrir o WebSocket. */
  allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
  /** Atrás de proxy reverso (Caddy/nginx): usa X-Forwarded-For para identificar o IP real. */
  trustProxy: flag('TRUST_PROXY'),
  /** Só para desenvolvimento/testes: libera URLs de rede privada no proxy. Nunca ligar em produção. */
  allowPrivateUrls: flag('ALLOW_PRIVATE_URLS'),
  /** Client ID da Discord Activity: a origem `https://<id>.discordsays.com` entra na lista de CORS. */
  discordClientId: process.env.VITE_DISCORD_CLIENT_ID || '1143016716520128553',
  /** Segredo que assina os tokens de sessão. Sem ele, um novo é gerado a cada início do servidor. */
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionSecretIsEphemeral: !process.env.SESSION_SECRET,
  /** Tamanho máximo de um envio individual. */
  maxUploadFileBytes: num('MAX_UPLOAD_FILE_GB', 50) * GB,
  /** Cota total de disco para `.uploads/`. */
  maxUploadDiskBytes: num('MAX_UPLOAD_DISK_GB', 20) * GB,
  /** Quantas horas um envio de sala encerrada continua no disco (contadas do fechamento, gravado em `.meta.json`). */
  uploadTtlMs: num('UPLOAD_TTL_HOURS', 24) * 3600 * 1000,
  /** Envio de sala que continua aberta, mas que ninguém lê há tanto tempo, também sai. */
  /**
   * Tamanho de cada pedaço do envio. Precisa ficar abaixo do limite de corpo do proxy na frente do servidor (a
   * Cloudflare gratuita recusa mais de 100 MB por requisição), então um arquivo grande sobe em vários pedaços.
   */
  uploadChunkBytes: Math.max(1024, Math.floor(num('UPLOAD_CHUNK_MB', 64) * 1024 * 1024)),
  uploadIdleMs: num('UPLOAD_IDLE_HOURS', 24) * 3600 * 1000,
  /** Quanto tempo o estado de uma sala fica no Redis sem ser regravado (quem decide se ainda vale é o relógio). */
  roomStateTtlMs: num('ROOM_STATE_TTL_HOURS', 24) * 3600 * 1000,
  /** Depois de um restart, o Host antigo tem este tempo de prioridade para voltar antes de outro assumir. */
  hostGraceMs: num('ROOM_HOST_GRACE_SECONDS', 60) * 1000,
  /** Fonte do catálogo: URL de instalação ou base de um addon do Stremio (AIOMetadata, Cinemeta…). Vazia = Cinemeta. */
  catalogUrl: process.env.CATALOG_URL?.trim() || '',
  /** Ponto de partida (MB/s) da estimativa de quanto o FFmpeg lê de um CDN; depois de ler arquivos de verdade vale a média medida por host. */
  ffmpegThroughputMbps: num('FFMPEG_THROUGHPUT_MBPS', 40),
  /** Redis do índice de envios, opcional (`redis://127.0.0.1:6379`): sem isso, só disco. */
  redisUrl: process.env.REDIS_URL?.trim() || undefined,
  /** Um envio só começa se, depois dele, ainda sobrarem tantos GB livres no disco da máquina. */
  minFreeDiskBytes: num('MIN_FREE_DISK_GB', 5) * GB,
  /** Limite de `.cache/` (legendas, fontes); acima disso apaga o menos usado. */
  maxCacheBytes: num('MAX_CACHE_GB', 10) * GB,
  /**
   * Idade máxima (sem uso) de cada tipo de cache em disco, independente do limite de tamanho. As fontes ficam mais
   * porque todas as legendas de um vídeo usam as mesmas; legendas custam 20 a 45 s para refazer (ficam mais);
   * o HLS guarda o vídeo inteiro copiado (centenas de MB por episódio), então sai logo.
   */
  cacheMaxAgeMs: {
    subtitles: num('CACHE_SUBTITLES_MAX_DAYS', 14) * 24 * 3600 * 1000,
    fonts: num('CACHE_FONTS_MAX_DAYS', 3) * 24 * 3600 * 1000,
    hls: num('CACHE_HLS_MAX_HOURS', 6) * 3600 * 1000,
    audio: num('CACHE_AUDIO_MAX_HOURS', 24) * 3600 * 1000,
  },
  /** FFmpeg/Python simultâneos no servidor inteiro. */
  maxFfmpegProcs: Math.max(1, Math.floor(num('MAX_FFMPEG_PROCS', 8))),
};
