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
  /** Quantas horas um envio de sala encerrada continua no disco. */
  uploadTtlMs: num('UPLOAD_TTL_HOURS', 6) * 3600 * 1000,
  /** Limite de `.cache/` (legendas, fontes); acima disso apaga o menos usado. */
  maxCacheBytes: num('MAX_CACHE_GB', 2) * GB,
  /** FFmpeg/Python simultâneos no servidor inteiro. */
  maxFfmpegProcs: Math.max(1, Math.floor(num('MAX_FFMPEG_PROCS', 8))),
};
