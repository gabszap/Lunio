import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, createLogger, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import { parseTorrentTitle } from '@viren070/parse-torrent-title';
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import crypto from 'crypto';
import fs from 'fs';
import { setupWebSocketServer } from './src/server/roomServer';
import { handleDrive, handleRoomInfo, handleUpload, handleUploadServe } from './src/server/sources';

// Connection pooling com Keep-Alive para streaming nativo em alta velocidade
const httpsKeepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 100,
  maxFreeSockets: 30,
  timeout: 60000,
});

const httpKeepAliveAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 100,
  maxFreeSockets: 30,
  timeout: 60000,
});

const resolvedUrlCache = new Map<string, string>();
const tracksCache = new Map<string, {
  title?: string;
  rawTitle?: string;
  duration?: number;
  parsedTorrent?: any;
  audios: any[];
  subtitles: any[];
  chapters?: any[];
  fonts?: any[];
  streamUrl?: string;
}>();

// Gerenciamento de processos de remux para Regions e Cold Seek controlado
interface ActiveRemuxProcess {
  proc: import('node:child_process').ChildProcess;
  sessionId: string;
  generation: number;
  url: string;
  startedAt: number;
  kill: () => void;
  seek: number;
  audio: string | null;
  /** Reconecta um novo request do navegador ao mesmo FFmpeg a partir do byte pedido. */
  attach: (req: http.IncomingMessage, res: http.ServerResponse, fromByte: number) => boolean;
}
// Quanto da saída do remux guardar para retomar após o navegador fechar/reabrir a conexão (pause, readahead)
const REMUX_TAIL_LIMIT = 96 * 1024 * 1024;
const activeRemuxProcesses = new Map<string, ActiveRemuxProcess>();
const pendingFontExtractions = new Map<string, Promise<void>>();

// Detecta caminho do FFmpeg (preferência pelo mpv ou instalação do sistema)
const FFMPEG_PATH = fs.existsSync('C:\\Program Files\\mpv\\ffmpeg.exe')
  ? 'C:\\Program Files\\mpv\\ffmpeg.exe'
  : (fs.existsSync('C:\\ffmpeg\\ffmpeg.exe') ? 'C:\\ffmpeg\\ffmpeg.exe' : 'ffmpeg');

// Detecta caminho do interpretador Python para o Remote Subtitle Extractor
const PYTHON_PATH = process.env.PYTHON_PATH || 'python';

const SUB_CACHE_DIR = path.resolve(__dirname, '.cache', 'subtitles');
const AUDIO_CACHE_DIR = path.resolve(__dirname, '.cache', 'audio');
const FONT_CACHE_DIR = path.resolve(__dirname, '.cache', 'fonts');

if (!fs.existsSync(SUB_CACHE_DIR)) {
  fs.mkdirSync(SUB_CACHE_DIR, { recursive: true });
}
if (!fs.existsSync(AUDIO_CACHE_DIR)) {
  fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
}
if (!fs.existsSync(FONT_CACHE_DIR)) {
  fs.mkdirSync(FONT_CACHE_DIR, { recursive: true });
}

function getMediaFingerprint(url: string, customFingerprint?: string): string {
  if (customFingerprint && customFingerprint.trim().length > 3) {
    return crypto.createHash('sha1').update(customFingerprint.trim()).digest('hex').slice(0, 16);
  }
  try {
    const parsed = new URL(url);
    // Remove apenas parâmetros efêmeros de autenticação/expiração conhecidos
    const ephemeralParams = ['token', 'expires', 'auth', 'api_key', 'session', 'ts', 'hmac', 'sig', 'signature', 'expiry'];
    for (const param of ephemeralParams) {
      parsed.searchParams.delete(param);
    }
    const normalizedUrl = parsed.origin + parsed.pathname + (parsed.search ? parsed.search : '');
    return crypto.createHash('sha1').update(normalizedUrl).digest('hex').slice(0, 16);
  } catch {
    return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  }
}

function getUrlHash(url: string): string {
  return getMediaFingerprint(url);
}

function extractFilenameFromUrl(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    const parts = parsed.pathname.split('/').map((p) => {
      try { return decodeURIComponent(p); } catch { return p; }
    });
    // Procura na ordem reversa algum segmento que termine com extensão de vídeo
    const mediaPart = parts.slice().reverse().find((p) => /\.(mkv|mp4|avi|webm|mov|m4v|ts)$/i.test(p));
    if (mediaPart) return mediaPart;
    // Caso não tenha extensão explícita, pega o último segmento não vazio
    const lastPart = parts.filter(Boolean).pop();
    return lastPart || '';
  } catch {
    return '';
  }
}

async function resolveFinalCdnUrl(url: string): Promise<string> {
  if (resolvedUrlCache.has(url)) {
    return resolvedUrlCache.get(url)!;
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Range': 'bytes=0-0',
      },
    });
    const finalUrl = res.url || url;
    if (res.ok && finalUrl !== url) {
      resolvedUrlCache.set(url, finalUrl);
      console.log('[Resolver] ✅ URL da CDN resolvida:', finalUrl);
    }
    return finalUrl;
  } catch (err: any) {
    console.warn('[Resolver] Falha ao resolver URL final, usando original:', err?.message);
    return url;
  }
}

const pendingSubtitleExtractions = new Map<string, Promise<string>>();
const activeSubtitleProcesses = new Map<string, () => void>();

/**
 * Extração de alta performance via mkv_extractor (HTTP Range + EBML Cues)
 * Baixa apenas ~1-2 MB da legenda em 3-8s em vez de GBs pelo FFmpeg.
 */
async function extractRemoteMkvSubtitle(
  streamUrl: string,
  track: string,
  outputFile: string,
  extractionKey: string
): Promise<string> {
  const args = [
    '-u',
    '-m', 'mkv_extractor',
    streamUrl,
    // Índice de stream do FFmpeg (o mesmo do /api/tracks), não o TrackNumber do Matroska
    '--stream-index', String(track),
    '-o', outputFile,
    '--json',
  ];

  return await new Promise<string>((resolve, reject) => {
    const proc = spawn(PYTHON_PATH, args, {
      cwd: __dirname,
    });
    let stderr = '';
    let stdout = '';
    proc.stderr?.on('data', (d) => stderr += d.toString());
    proc.stdout?.on('data', (d) => stdout += d.toString());

    activeSubtitleProcesses.set(extractionKey, () => {
      try {
        console.log(`[MkvExtractor] ⏹ Cancelando extração remota da faixa #${track}...`);
        proc.kill('SIGKILL');
      } catch {}
    });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error('Tempo limite de 60s excedido no mkv_extractor.'));
    }, 60000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outputFile) && fs.statSync(outputFile).size > 50) {
        try {
          const content = fs.readFileSync(outputFile, 'utf-8');
          resolve(content);
        } catch (err: any) {
          reject(err);
        }
      } else {
        const errMsg = (stderr || stdout || '').trim();
        reject(new Error(`mkv_extractor finalizou com código ${code}: ${errMsg.slice(-300)}`));
      }
    });
  });
}

/**
 * Extração individual resiliente: mkv_extractor primeiro, FFmpeg como fallback
 */
async function extractSubtitleTrack(targetUrl: string, track: string, customFingerprint?: string): Promise<string> {
  const hash = getMediaFingerprint(targetUrl, customFingerprint);
  // Prefixo "s" = índice de stream do FFmpeg. O cache antigo ("_track") podia conter a faixa vizinha (bug de índice).
  const cacheFile = path.join(SUB_CACHE_DIR, `${hash}_s${track}.ass`);

  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 100) {
    return fs.readFileSync(cacheFile, 'utf-8');
  }

  // Remove arquivo corrompido ou incompleto com 0 bytes
  if (fs.existsSync(cacheFile)) {
    try { fs.unlinkSync(cacheFile); } catch {}
  }

  const extractionKey = `${hash}_${track}`;
  if (pendingSubtitleExtractions.has(extractionKey)) {
    return await pendingSubtitleExtractions.get(extractionKey)!;
  }

  const extractionPromise = (async () => {
    try {
      const streamUrl = await resolveFinalCdnUrl(targetUrl);
      const cachedTracks = tracksCache.get(targetUrl);
      const subInfo = cachedTracks?.subtitles?.find((s: any) => String(s.index) === String(track));
      const subCodec = (subInfo?.codec || '').toLowerCase();

      // Se for formato bitmap (PGS, VobSub), rejeita com código específico para o resolver dar fallback
      if (subCodec === 'none' || /pgs|pgssub|dvd_sub|dvb_sub|xsub|dvdsub|vobsub|bitmap/i.test(subCodec)) {
        const err: any = new Error('Formato bitmap/PGS não suporta extração direta de texto.');
        err.code = 'BITMAP_NOT_SUPPORTED';
        throw err;
      }

      const tmpFile = path.join(SUB_CACHE_DIR, `${hash}_track${track}_${Date.now()}.tmp`);

      // 1. Tenta primeiro extração remota ultrarrápida via HTTP Range (módulo mkv_extractor)
      const isCandidateMkv = targetUrl.toLowerCase().includes('.mkv') ||
                             streamUrl.toLowerCase().includes('.mkv') ||
                             subCodec.includes('ass') ||
                             subCodec.includes('ssa');

      if (isCandidateMkv) {
        try {
          console.log(`[Subtitle] 🚀 Tentando extração remota ultrarrápida (HTTP Range / EBML) para faixa #${track}...`);
          const t0 = Date.now();
          const content = await extractRemoteMkvSubtitle(streamUrl, track, tmpFile, extractionKey);

          if (fs.existsSync(tmpFile)) {
            if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
            fs.renameSync(tmpFile, cacheFile);
          }
          const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(`[Subtitle] ⚡ Sucesso! Faixa #${track} extraída via mkv_extractor em ${elapsedSec}s (${content.length} bytes).`);
          return content;
        } catch (mkvErr: any) {
          console.warn(`[Subtitle] ⚠️ mkv_extractor não conseguiu processar faixa #${track} (${mkvErr.message?.slice(0, 150)}). Acionando fallback FFmpeg...`);
          try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
        }
      }

      // 2. Fallback resiliente com FFmpeg completo
      console.log(`[Subtitle] 🔄 Iniciando extração de compatibilidade via FFmpeg para faixa #${track}...`);

      const subCodecArgs = (subCodec.includes('ass') || subCodec.includes('ssa'))
        ? ['-c:s', 'copy']
        : ['-c:s', 'ass'];

      const args = [
        '-hide_banner',
        '-v', 'error',
        '-reconnect', '1',
        '-reconnect_at_eof', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\nAccept-Encoding: identity\r\n',
        '-multiple_requests', '1',
        '-probesize', '32M',
        '-analyzeduration', '10M',
        '-i', streamUrl,
        '-vn',
        '-an',
        '-dn',
        '-map', `0:${track}`,
        ...subCodecArgs,
        '-f', 'ass',
        '-y',
        tmpFile,
      ];

      return await new Promise<string>((resolve, reject) => {
        const proc = spawn(FFMPEG_PATH, args);
        let stderr = '';
        proc.stderr?.on('data', (d) => stderr += d.toString());

        activeSubtitleProcesses.set(extractionKey, () => {
          try {
            console.log(`[Subtitle] ⏹ Cancelando extração da faixa #${track} (processo descartado/obsoleto)...`);
            proc.kill('SIGKILL');
          } catch {}
        });

        const timer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          const timeoutErr: any = new Error('Tempo limite de 480s excedido ao extrair legenda individual.');
          timeoutErr.code = 'EXTRACTION_FAILED';
          reject(timeoutErr);
        }, 480000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          activeSubtitleProcesses.delete(extractionKey);
          if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 50) {
            try {
              if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
              fs.renameSync(tmpFile, cacheFile);
              const content = fs.readFileSync(cacheFile, 'utf-8');
              console.log(`[Subtitle] ✅ Legenda #${track} extraída com sucesso (${content.length} bytes).`);
              resolve(content);
            } catch {
              resolve(fs.readFileSync(tmpFile, 'utf-8'));
            }
          } else {
            try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
            console.warn(`[Subtitle] Falha ao extrair #${track} (code ${code}): ${stderr}`);
            const err: any = new Error(`Falha ao extrair legenda #${track}: ${stderr.slice(-300) || 'Erro no processo FFmpeg'}`);
            err.code = 'EXTRACTION_FAILED';
            reject(err);
          }
        });
      });
    } finally {
      pendingSubtitleExtractions.delete(extractionKey);
      activeSubtitleProcesses.delete(extractionKey);
    }
  })();

  pendingSubtitleExtractions.set(extractionKey, extractionPromise);
  return await extractionPromise;
}

/**
 * Obtém a legenda instantaneamente do cache em disco (0ms) ou extrai individualmente sob demanda
 */
async function getOrExtractSubtitle(targetUrl: string, track: string, customFingerprint?: string): Promise<string> {
  const hash = getMediaFingerprint(targetUrl, customFingerprint);
  const cacheFile = path.join(SUB_CACHE_DIR, `${hash}_s${track}.ass`);

  // Se já existe no cache e é válido, responde em 0ms
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 100) {
    return fs.readFileSync(cacheFile, 'utf-8');
  }

  // Extração pontual exclusiva da faixa selecionada
  return await extractSubtitleTrack(targetUrl, track, customFingerprint);
}

/**
 * Streaming direto com HTTP 206 Partial Content, suporte a Range e redirecionamento de links Debrid/Torrentio.
 */
function pipeMediaStreamDirect(
  actualUrl: string,
  targetUrl: string,
  req: any,
  res: any,
  redirectsLeft = 5
) {
  try {
    const parsedUrl = new URL(actualUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;
    const agent = isHttps ? httpsKeepAliveAgent : httpKeepAliveAgent;

    const reqHeaders: Record<string, string | string[]> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Connection': 'keep-alive',
    };

    if (req.headers['range']) {
      reqHeaders['range'] = req.headers['range'];
    }

    const proxyReq = client.request(
      parsedUrl,
      {
        method: req.method || 'GET',
        headers: reqHeaders,
        agent,
      },
      (upstreamRes) => {
        // Redirecionamentos (301, 302, 303, 307, 308) comuns em Torrentio /resolve
        if (
          upstreamRes.statusCode &&
          [301, 302, 303, 307, 308].includes(upstreamRes.statusCode) &&
          upstreamRes.headers.location
        ) {
          if (redirectsLeft <= 0) {
            res.statusCode = 508;
            res.end('Too many redirects');
            return;
          }
          const nextUrl = new URL(upstreamRes.headers.location, actualUrl).href;
          resolvedUrlCache.set(targetUrl, nextUrl);
          upstreamRes.resume();
          pipeMediaStreamDirect(nextUrl, targetUrl, req, res, redirectsLeft - 1);
          return;
        }

        // Se o token ou CDN expirou/falhou (400, 401, 403, 404, 410) e tínhamos URL em cache, revalida com a original
        if (
          upstreamRes.statusCode &&
          upstreamRes.statusCode >= 400 &&
          upstreamRes.statusCode < 500 &&
          actualUrl !== targetUrl
        ) {
          console.warn(`[MediaProxy] Upstream CDN retornou status ${upstreamRes.statusCode}. Invalidando cache da CDN e renovando com URL original...`);
          resolvedUrlCache.delete(targetUrl);
          upstreamRes.resume();
          pipeMediaStreamDirect(targetUrl, targetUrl, req, res, redirectsLeft - 1);
          return;
        }

        if (upstreamRes.statusCode && upstreamRes.statusCode >= 400) {
          let errBody = '';
          upstreamRes.on('data', (d: any) => { errBody += d.toString(); });
          upstreamRes.on('end', () => {
            console.error(`[MediaProxy] ❌ Servidor upstream retornou erro ${upstreamRes.statusCode}: ${errBody.slice(0, 300)}`);
          });
        }

        if (actualUrl !== targetUrl && upstreamRes.statusCode && upstreamRes.statusCode < 400) {
          resolvedUrlCache.set(targetUrl, actualUrl);
        }

        const outHeaders: Record<string, any> = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Accept-Ranges': 'bytes',
        };

        const passHeaders = [
          'content-type',
          'content-length',
          'content-range',
          'etag',
          'last-modified',
          'content-disposition',
        ];

        for (const h of passHeaders) {
          const val = upstreamRes.headers[h];
          if (val !== undefined) {
            outHeaders[h] = val;
          }
        }

        const currentType = upstreamRes.headers['content-type'] as string;
        if (!currentType || currentType === 'application/octet-stream' || currentType.includes('matroska') || targetUrl.toLowerCase().includes('.mkv')) {
          outHeaders['content-type'] = 'video/mp4';
        } else if (targetUrl.toLowerCase().includes('.webm')) {
          outHeaders['content-type'] = 'video/webm';
        }

        res.writeHead(upstreamRes.statusCode || 200, outHeaders);

        if (req.method === 'HEAD') {
          upstreamRes.resume();
          res.end();
          return;
        }

        upstreamRes.pipe(res);

        const cleanUp = () => {
          try {
            proxyReq.destroy();
            upstreamRes.destroy();
          } catch {}
        };

        res.on('close', cleanUp);
        res.on('error', cleanUp);
      }
    );

    proxyReq.on('error', (err: any) => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end(`Proxy error: ${err.message}`);
      }
    });

    req.on('close', () => {
      try {
        proxyReq.destroy();
      } catch {}
    });

    proxyReq.end();
  } catch (err: any) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(`Proxy setup error: ${err.message}`);
    }
  }
}

/** Só o que as rotas usam: igual no servidor de dev (`vite`) e no de produção (`vite preview`). */
type MediaRouteHost = {
  middlewares: ViteDevServer['middlewares'];
  httpServer: ViteDevServer['httpServer'] | PreviewServer['httpServer'] | null;
};

function mediaProxyPlugin(): Plugin {
  // API de mídia/salas + WebSocket. Registrada nos dois servidores, então `npm run preview` serve o build
  // de produção com o backend completo (sem HMR, sem código-fonte exposto).
  const setup = (server: MediaRouteHost) => {
    // Inicializa o servidor WebSocket para Watch Party em /api/ws e /.proxy/api/ws
    if (server.httpServer) {
      setupWebSocketServer(server.httpServer);
    }

    // Suporte ao Discord Activity URL Mapping prefix /.proxy/api/*
    server.middlewares.use((req, res, next) => {
      if (req.url && req.url.startsWith('/.proxy/api/')) {
        req.url = req.url.replace('/.proxy', '');
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
      next();
    });

    // Fontes de vídeo da Home: checagem de sala, upload de arquivo e links do Google Drive
    server.middlewares.use('/api/room', handleRoomInfo);
    server.middlewares.use('/api/upload', (req, res, next) => (req.method === 'POST' ? handleUpload(req, res) : next()));
    server.middlewares.use('/api/uploads', handleUploadServe);
    server.middlewares.use('/api/drive', (req, res) => {
      void handleDrive(req, res);
    });

    // Endpoint Token: Discord Activity OAuth2 exchange para autenticação e fotos reais
    server.middlewares.use('/api/token', async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body || '{}');
          const code = data.code;
          if (!code) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Missing code' }));
            return;
          }

          let clientSecret = process.env.DISCORD_CLIENT_SECRET || process.env.VITE_DISCORD_CLIENT_SECRET;
          let clientId = process.env.VITE_DISCORD_CLIENT_ID || '1143016716520128553';

          try {
            const envPath = path.resolve(__dirname, '.env');
            if (fs.existsSync(envPath)) {
              const envContent = fs.readFileSync(envPath, 'utf-8');
              for (const line of envContent.split('\n')) {
                const l = line.trim();
                if (l.startsWith('DISCORD_CLIENT_SECRET=')) {
                  clientSecret = l.replace('DISCORD_CLIENT_SECRET=', '').trim();
                } else if (l.startsWith('VITE_DISCORD_CLIENT_SECRET=')) {
                  clientSecret = l.replace('VITE_DISCORD_CLIENT_SECRET=', '').trim();
                } else if (l.startsWith('VITE_DISCORD_CLIENT_ID=')) {
                  clientId = l.replace('VITE_DISCORD_CLIENT_ID=', '').trim();
                }
              }
            }
          } catch {}

          if (!clientSecret) {
            console.warn('[Discord Auth] DISCORD_CLIENT_SECRET não encontrado no ambiente nem no .env');
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'DISCORD_CLIENT_SECRET not configured' }));
            return;
          }

          console.log(`[Discord Auth] ✅ DISCORD_CLIENT_SECRET carregado. Client ID: ${clientId}. Trocando código por token no Discord...`);

          const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              client_id: clientId,
              client_secret: clientSecret,
              grant_type: 'authorization_code',
              code: code,
            }),
          });

          const tokenData = await tokenRes.json();
          if (!tokenRes.ok) {
            console.warn(`[Discord Auth] Resposta da API do Discord (${tokenRes.status}):`, tokenData);
          } else {
            console.log('[Discord Auth] ✅ Token obtido com sucesso!');
          }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify(tokenData));
        } catch (err: any) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    });

    // 1. Endpoint Proxy: Streaming e remux fMP4 on-the-fly via FFmpeg
    server.middlewares.use('/api/proxy', async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '', 'http://localhost');
        const targetUrl = reqUrl.searchParams.get('url');
        const audioTrack = reqUrl.searchParams.get('audio');
        const seekSeconds = parseFloat(reqUrl.searchParams.get('ss') || '0');
        const sessionId = reqUrl.searchParams.get('session') || '';
        const generation = parseInt(reqUrl.searchParams.get('gen') || '0', 10);
        const explicitRemux = reqUrl.searchParams.get('remux') === 'true';

        if (!targetUrl) {
          res.statusCode = 400;
          res.end('Missing url parameter');
          return;
        }

        // Remux via FFmpeg ativado APENAS quando o usuário selecionar dublagem alternativa específica ou explicitamente solicitado
        const hasCustomAudio =
          audioTrack !== null &&
          audioTrack !== undefined &&
          audioTrack !== '' &&
          audioTrack !== '0';
        const shouldRemux = hasCustomAudio || explicitRemux;

        if (shouldRemux) {
          const remuxKey = sessionId ? `session_${sessionId}` : `url_${getMediaFingerprint(targetUrl)}_${audioTrack || '0'}`;
          const rangeMatch = /bytes=(\d+)-/.exec(String(req.headers['range'] || ''));
          const rangeStart = rangeMatch ? parseInt(rangeMatch[1], 10) : 0;

          // O navegador costuma abrir a mesma URL de remux duas vezes seguidas (e pode reabrir após suspender
          // o download). Mesma geração e mesmo ponto = mesma mídia: reaproveita o FFmpeg e o que ele já gerou
          // em vez de matar o processo e recomeçar do `ss`.
          const existing = activeRemuxProcesses.get(remuxKey);
          if (existing && existing.generation === generation && existing.seek === seekSeconds && existing.audio === audioTrack) {
            if (existing.attach(req, res, rangeStart)) {
              console.log(`[MediaProxy] ⏯️ Reconexão do navegador: retomando remux existente a partir do byte ${rangeStart} [Geração ${generation}]`);
              return;
            }
            console.log(`[MediaProxy] Byte ${rangeStart} fora do buffer do remux; reiniciando FFmpeg.`);
          }

          // Cancela processo FFmpeg anterior imediatamente ao detectar nova geração / Cold Seek
          if (existing) {
            console.log(`[MediaProxy] ❄️ Cold Seek físico detectado (Gen ${generation} vs anterior ${existing.generation}). Cancelando processo FFmpeg anterior imediatamente...`);
            existing.kill();
            activeRemuxProcesses.delete(remuxKey);
          }

          console.log(`[MediaProxy] 🎬 Remuxando fMP4 via FFmpeg: áudio #${audioTrack || 'default'}, seek ${seekSeconds}s [Geração ${generation} / Session ${sessionId || 'none'}]...`);

          let streamUrl = await resolveFinalCdnUrl(targetUrl);
          const ffmpegArgs: string[] = [
            '-hide_banner',
            '-v', 'error',
            '-reconnect', '1',
            '-reconnect_at_eof', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n',
          ];

          if (seekSeconds > 0) {
            ffmpegArgs.push('-ss', seekSeconds.toFixed(2));
          }

          ffmpegArgs.push('-i', streamUrl);
          ffmpegArgs.push('-map', '0:v:0');

          if (audioTrack !== null && audioTrack !== undefined && audioTrack !== '') {
            ffmpegArgs.push('-map', `0:${audioTrack}`);
          } else {
            ffmpegArgs.push('-map', '0:a:0?');
          }

          ffmpegArgs.push(
            '-fflags', '+genpts+discardcorrupt',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-ac', '2',
            '-b:a', '256k',
            '-af', 'aresample=async=1,volume=1.8',
            '-avoid_negative_ts', 'make_zero',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-f', 'mp4',
            '-'
          );

          const ffmpegProc = spawn(FFMPEG_PATH, ffmpegArgs);

          // Últimos bytes produzidos (para retomar) + quem está consumindo agora
          const tail: Buffer[] = [];
          let tailStart = 0;
          let tailBytes = 0;
          let bytesOut = 0;
          let ended = false;
          let current: http.ServerResponse | null = null;
          let closeTimer: NodeJS.Timeout | null = null;

          let isCleanedUp = false;
          const cleanUp = () => {
            if (isCleanedUp) return;
            isCleanedUp = true;
            try {
              ffmpegProc.kill('SIGKILL');
            } catch {}
            if (current && !current.writableEnded) current.end();
            current = null;
            tail.length = 0;
            if (activeRemuxProcesses.get(remuxKey)?.proc === ffmpegProc) {
              activeRemuxProcesses.delete(remuxKey);
            }
          };

          // Mantém o FFmpeg vivo (parado por backpressure) durante pausas de até 90s
          const scheduleCleanUp = () => {
            if (closeTimer || isCleanedUp) return;
            closeTimer = setTimeout(cleanUp, 90000);
          };

          ffmpegProc.stdout.on('data', (chunk: Buffer) => {
            tail.push(chunk);
            tailBytes += chunk.length;
            bytesOut += chunk.length;
            while (tail.length > 1 && tailBytes - tail[0].length >= REMUX_TAIL_LIMIT) {
              const dropped = tail.shift()!;
              tailBytes -= dropped.length;
              tailStart += dropped.length;
            }
            if (current && !current.writableEnded) {
              if (!current.write(chunk)) {
                ffmpegProc.stdout.pause();
                const res0 = current;
                res0.once('drain', () => {
                  if (current === res0) ffmpegProc.stdout.resume();
                });
              }
            } else {
              // Ninguém ouvindo: segura o FFmpeg até o navegador reconectar
              ffmpegProc.stdout.pause();
            }
          });
          ffmpegProc.stdout.on('end', () => {
            ended = true;
            if (current && !current.writableEnded) current.end();
          });

          const attach = (aReq: http.IncomingMessage, aRes: http.ServerResponse, fromByte: number): boolean => {
            if (isCleanedUp || fromByte < tailStart || fromByte > bytesOut) return false;
            if (closeTimer) {
              clearTimeout(closeTimer);
              closeTimer = null;
            }
            if (current && current !== aRes && !current.writableEnded) current.end();
            current = aRes;

            aRes.setHeader('Content-Type', 'video/mp4');
            aRes.setHeader('Accept-Ranges', 'none');
            aRes.setHeader('Cache-Control', 'no-cache, no-store');
            aRes.setHeader('Connection', 'keep-alive');
            aRes.setHeader('Access-Control-Allow-Origin', '*');
            aRes.setHeader('Access-Control-Allow-Headers', '*');
            if (sessionId) aRes.setHeader('X-MediaRun-Session', sessionId);
            if (generation) aRes.setHeader('X-MediaRun-Generation', String(generation));
            aRes.setHeader('X-MediaRegion-Start', seekSeconds.toFixed(2));
            if (fromByte > 0) {
              // Tamanho total desconhecido (stream ao vivo do FFmpeg)
              aRes.statusCode = 206;
              aRes.setHeader('Content-Range', `bytes ${fromByte}-${Number.MAX_SAFE_INTEGER - 1}/*`);
            } else {
              aRes.statusCode = 200;
            }

            // Reenvia o que o navegador ainda não tinha recebido
            let offset = tailStart;
            for (const chunk of tail) {
              const chunkEnd = offset + chunk.length;
              if (chunkEnd > fromByte) aRes.write(fromByte > offset ? chunk.subarray(fromByte - offset) : chunk);
              offset = chunkEnd;
            }

            if (ended) aRes.end();
            else ffmpegProc.stdout.resume();

            const onClose = () => {
              if (current === aRes) {
                current = null;
                ffmpegProc.stdout.pause();
                scheduleCleanUp();
              }
            };
            aReq.on('close', onClose);
            aRes.on('close', onClose);
            return true;
          };

          activeRemuxProcesses.set(remuxKey, {
            proc: ffmpegProc,
            sessionId,
            generation,
            url: targetUrl,
            startedAt: Date.now(),
            kill: cleanUp,
            seek: seekSeconds,
            audio: audioTrack,
            attach,
          });

          attach(req, res, 0);

          ffmpegProc.stderr.on('data', (d) => {
            console.warn('[FFmpeg Stderr]', d.toString());
          });

          return;
        }

        // Streaming direto via Range 206 com CDN pré-resolvida
        const actualFetchUrl = await resolveFinalCdnUrl(targetUrl);
        pipeMediaStreamDirect(actualFetchUrl, targetUrl, req, res);
      } catch (err: any) {
        console.error('[MediaProxy] Erro geral:', err);
        if (!res.headersSent) {
          res.statusCode = 502;
          res.end(`Proxy error: ${err.message}`);
        }
      }
    });

    // 2. Endpoint Resolve: Resolve redirecionamento do Torrentio para a CDN do TorBox
    server.middlewares.use('/api/resolve', async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '', 'http://localhost');
        const targetUrl = reqUrl.searchParams.get('url');
        if (!targetUrl) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing url' }));
          return;
        }

        if (resolvedUrlCache.has(targetUrl)) {
          const cachedUrl = resolvedUrlCache.get(targetUrl)!;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify({ cdnUrl: cachedUrl }));
          return;
        }

        const headRes = await fetch(targetUrl, {
          method: 'GET',
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Range': 'bytes=0-0',
          },
        });

        const finalUrl = headRes.url || targetUrl;
        if (headRes.ok && finalUrl !== targetUrl) {
          resolvedUrlCache.set(targetUrl, finalUrl);
          console.log('[Resolver] ✅ URL resolvida com sucesso:', finalUrl);
        }

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(JSON.stringify({ cdnUrl: finalUrl }));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message }));
      }
    });

    // 3. Endpoint Tracks: Inspeciona faixas de áudio, legendas e capítulos via FFmpeg
    server.middlewares.use('/api/tracks', async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '', 'http://localhost');
        const targetUrl = reqUrl.searchParams.get('url');
        if (!targetUrl) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing url parameter' }));
          return;
        }

        if (tracksCache.has(targetUrl)) {
          const cached = tracksCache.get(targetUrl)!;
          const hasGenericChapters =
            cached.chapters &&
            cached.chapters.length > 0 &&
            cached.chapters.some((c: any) => /^Capítulo \d+$/i.test(c.title));

          const hasNoneSubtitles =
            cached.subtitles &&
            cached.subtitles.some((s: any) => s.codec === 'none');

          const hasDuration = typeof cached.duration === 'number' && cached.duration > 0;

          if (!hasGenericChapters && !hasNoneSubtitles && hasDuration) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(JSON.stringify(cached));
            return;
          }
          tracksCache.delete(targetUrl);
        }

        let streamUrl = await resolveFinalCdnUrl(targetUrl);

        const args = [
          '-hide_banner',
          '-reconnect', '1',
          '-reconnect_at_eof', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n',
          '-probesize', '10M',
          '-analyzeduration', '10M',
          '-i', streamUrl,
        ];

        const proc = spawn(FFMPEG_PATH, args);
        let stderr = '';

        proc.stderr.on('data', (d) => stderr += d.toString());

        proc.on('close', () => {
          try {
            const audios: any[] = [];
            const subtitles: any[] = [];
            const chapters: any[] = [];
            const fonts: any[] = [];

            // Sanitiza todas as linhas removendo retornos de carro (\r do Windows) e espaços
            const rawLines = stderr.split('\n');
            const streamLines = rawLines.map((l) => l.replace(/\r/g, '').trim()).filter(Boolean);

            let currentStream: any = null;
            let currentChapter: any = null;
            let mediaTitle = '';

            for (const line of streamLines) {
              // Parse de Capítulos: Chapter #0:1: start 706.000000, end 802.000000
              const chapterMatch = line.match(/^Chapter #0:(\d+): start ([\d.]+), end ([\d.]+)/i);
              if (chapterMatch) {
                currentStream = null;
                const cIndex = parseInt(chapterMatch[1], 10);
                const cStart = parseFloat(chapterMatch[2]);
                const cEnd = parseFloat(chapterMatch[3]);
                currentChapter = {
                  index: cIndex,
                  startTime: cStart,
                  endTime: cEnd,
                  title: '',
                };
                chapters.push(currentChapter);
                continue;
              }

              // Parse de Streams (suporta Audio, Subtitle, Video e Attachment para fontes embutidas)
              const streamMatch = line.match(/^Stream #0:(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?(?:\[[^\]]+\])?:\s*(Audio|Subtitle|Video|Attachment):\s*([^,\n\r]+)/i);
              if (streamMatch) {
                currentChapter = null;
                const index = parseInt(streamMatch[1], 10);
                const lang = (streamMatch[2] || 'und').toLowerCase();
                const type = streamMatch[3].toLowerCase();
                const codec = streamMatch[4].trim();
                const lineLower = line.toLowerCase();
                const isForced = lineLower.includes('forced');
                const isDefault = lineLower.includes('default');

                currentStream = {
                  index,
                  type,
                  codec,
                  language: lang,
                  title: '',
                  filename: '',
                  mimetype: '',
                  isForced,
                  isDefault,
                };

                if (type === 'audio') {
                  audios.push(currentStream);
                } else if (type === 'subtitle') {
                  subtitles.push(currentStream);
                } else if (type === 'attachment') {
                  fonts.push(currentStream);
                }
                continue;
              }

              // Metadados de Anexo (fontes embutidas TTF/OTF)
              const filenameMatch = line.match(/^filename\s*:\s*(.+)$/i);
              if (filenameMatch && currentStream) {
                currentStream.filename = filenameMatch[1].trim();
                if (!currentStream.title) currentStream.title = currentStream.filename;
                continue;
              }
              const mimetypeMatch = line.match(/^mimetype\s*:\s*(.+)$/i);
              if (mimetypeMatch && currentStream) {
                currentStream.mimetype = mimetypeMatch[1].trim();
                continue;
              }

              // Títulos de Streams ou Chapters (suporta title, name, chapter_name)
              const metaTitleMatch = line.match(/^(?:title|name|chapter_name)\s*:\s*(.+)$/i);
              if (metaTitleMatch) {
                const parsedTitle = metaTitleMatch[1].trim();
                if (!currentChapter && !currentStream && !mediaTitle) {
                  mediaTitle = parsedTitle;
                  continue;
                }
                if (currentChapter && !currentChapter.title) {
                  currentChapter.title = parsedTitle;
                  currentChapter = null;
                  continue;
                }
                if (currentStream && !currentStream.title) {
                  currentStream.title = parsedTitle;
                  const titleLower = parsedTitle.toLowerCase();
                  if (titleLower.includes('forced') || titleLower.includes('sign') || titleLower.includes('song') || titleLower.includes('placa')) {
                    currentStream.isForced = true;
                  }
                  continue;
                }
              }
            }

            // Preenche fallback apenas para capítulos que realmente não tinham título no arquivo
            chapters.forEach((c) => {
              if (!c.title || c.title.trim() === '') {
                c.title = `Capítulo ${c.index + 1}`;
              }
            });

            // Normaliza títulos de áudio
            function formatAudioTitle(a: any): string {
              const lang = (a.language || '').toLowerCase();
              const rawTitle = (a.title || '').trim();
              const t = rawTitle.toLowerCase();

              if (lang.includes('chi') || lang.includes('zh') || t.includes('zh-cn') || t.includes('mandar')) {
                return '🇨🇳 Chinês (Mandarim Original)';
              }
              if (lang.includes('jpn') || lang.includes('ja') || t.includes('ja-jp') || t.includes('japon')) {
                return '🇯🇵 Japonês';
              }
              if (lang.includes('por') || lang.includes('pt') || t.includes('pt-br') || t.includes('portug')) {
                return '🇧🇷 Português (Brasil)';
              }
              if (lang.includes('eng') || lang.includes('en') || t.includes('en-us')) {
                return '🇺🇸 Inglês';
              }
              if (t.includes('es-419') || t.includes('latino') || (lang.includes('spa') && !t.includes('es-es'))) {
                return '🇲🇽 Espanhol (Latino)';
              }
              if (t.includes('es-es') || t.includes('castellano') || t.includes('spain')) {
                return '🇪🇸 Espanhol (Espanha)';
              }
              if (lang.includes('fre') || lang.includes('fra') || lang.includes('fr')) return '🇫🇷 Francês';
              if (lang.includes('ger') || lang.includes('deu') || lang.includes('de')) return '🇩🇪 Alemão';
              if (lang.includes('ita') || lang.includes('it')) return '🇮🇹 Italiano';
              if (lang.includes('rus') || lang.includes('ru')) return '🇷🇺 Russo';
              if (lang.includes('kor') || lang.includes('ko')) return '🇰🇷 Coreano';
              if (lang.includes('ara') || lang.includes('ar')) return '🇸🇦 Árabe';
              return rawTitle || (lang !== 'und' ? lang.toUpperCase() : `Áudio #${a.index}`);
            }

            audios.forEach((a) => {
              a.title = formatAudioTitle(a);
            });

            // Normaliza legendas com suporte completo a línguas mundiais
            subtitles.forEach((s) => {
              const lang = (s.language || '').toLowerCase();
              const rawTitle = (s.title || '').trim();
              const t = rawTitle.toLowerCase();
              const isForced = s.isForced || t.includes('forced') || t.includes('sign') || t.includes('song') || t.includes('placa');
              const isCaptions = t.includes('caption') || t.includes('sdh');

              let baseName = '';
              let flag = '';

              if (lang.includes('por') || lang.includes('pt') || t.includes('pt-br') || t.includes('portug')) {
                baseName = t.includes('pt-pt') || t.includes('portugal') ? 'Português (Portugal)' : 'Português';
                flag = t.includes('pt-pt') || t.includes('portugal') ? '🇵🇹 ' : '🇧🇷 ';
              } else if (lang.includes('eng') || lang.includes('en') || t.includes('en-us')) {
                baseName = 'Inglês';
                flag = '🇺🇸 ';
              } else if (t.includes('es-es') || t.includes('castellano') || t.includes('spain') || t.includes('european') || t.includes('europeo') || t.includes('europe')) {
                baseName = 'Espanhol (Espanha)';
                flag = '🇪🇸 ';
              } else if (lang.includes('spa') || lang.includes('es') || t.includes('es-419') || t.includes('latino')) {
                baseName = 'Espanhol (Latino)';
                flag = '🇲🇽 ';
              } else if (lang.includes('fre') || lang.includes('fra') || lang.includes('fr')) {
                baseName = 'Francês';
                flag = '🇫🇷 ';
              } else if (lang.includes('ger') || lang.includes('deu') || lang.includes('de')) {
                baseName = 'Alemão';
                flag = '🇩🇪 ';
              } else if (lang.includes('ita') || lang.includes('it')) {
                baseName = 'Italiano';
                flag = '🇮🇹 ';
              } else if (lang.includes('rus') || lang.includes('ru')) {
                baseName = 'Russo';
                flag = '🇷🇺 ';
              } else if (lang.includes('chi') || lang.includes('zh') || lang.includes('zho')) {
                if (t.includes('hong kong') || t.includes('hk') || t.includes('canton')) {
                  baseName = 'Chinês (Hong Kong / Tradicional)';
                  flag = '🇭🇰 ';
                } else if (t.includes('mandar') || t.includes('putonghua')) {
                  baseName = 'Chinês (Mandarim)';
                  flag = '🇨🇳 ';
                } else if (t.includes('trad') || t.includes('hant') || t.includes('taiwan') || t.includes('tw')) {
                  baseName = 'Chinês (Tradicional)';
                  flag = '🇨🇳 ';
                } else if (t.includes('simp') || t.includes('hans') || t.includes('china')) {
                  baseName = 'Chinês (Simplificado)';
                  flag = '🇨🇳 ';
                } else {
                  baseName = 'Chinês';
                  flag = '🇨🇳 ';
                }
              } else if (lang.includes('jpn') || lang.includes('ja')) {
                baseName = 'Japonês';
                flag = '🇯🇵 ';
              } else if (lang.includes('kor') || lang.includes('ko')) {
                baseName = 'Coreano';
                flag = '🇰🇷 ';
              } else if (lang.includes('ara') || lang.includes('ar')) {
                baseName = 'Árabe';
                flag = '🇸🇦 ';
              } else if (lang.includes('hin') || lang.includes('hi')) {
                baseName = 'Hindi';
                flag = '🇮🇳 ';
              } else if (lang.includes('tur') || lang.includes('tr')) {
                baseName = 'Turco';
                flag = '🇹🇷 ';
              } else if (lang.includes('pol') || lang.includes('pl')) {
                baseName = 'Polonês';
                flag = '🇵🇱 ';
              } else if (lang.includes('dut') || lang.includes('nld') || lang.includes('nl')) {
                baseName = 'Holandês';
                flag = '🇳🇱 ';
              } else if (lang.includes('ind') || lang.includes('id')) {
                baseName = 'Indonésio';
                flag = '🇮🇩 ';
              } else if (lang.includes('may') || lang.includes('msa') || lang === 'ms' || t.includes('malay') || t.includes('malaio')) {
                baseName = 'Malaio';
                flag = '🇲🇾 ';
              } else if (lang.includes('swe') || lang.includes('sv')) {
                baseName = 'Sueco';
                flag = '🇸🇪 ';
              } else if (lang.includes('tha') || lang.includes('th')) {
                baseName = 'Tailandês';
                flag = '🇹🇭 ';
              } else if (lang.includes('vie') || lang.includes('vi')) {
                baseName = 'Vietnamita';
                flag = '🇻🇳 ';
              } else if (lang.includes('ukr') || lang.includes('uk')) {
                baseName = 'Ucraniano';
                flag = '🇺🇦 ';
              } else if (lang.includes('cze') || lang.includes('ces') || lang.includes('cs')) {
                baseName = 'Tcheco';
                flag = '🇨🇿 ';
              } else if (lang.includes('hun') || lang.includes('hu')) {
                baseName = 'Húngaro';
                flag = '🇭🇺 ';
              } else if (lang.includes('rum') || lang.includes('ron') || lang.includes('ro')) {
                baseName = 'Romeno';
                flag = '🇷🇴 ';
              } else if (lang.includes('dan') || lang.includes('da')) {
                baseName = 'Dinamarquês';
                flag = '🇩🇰 ';
              } else if (lang.includes('nor') || lang.includes('no')) {
                baseName = 'Norueguês';
                flag = '🇳🇴 ';
              } else if (lang.includes('fin') || lang.includes('fi')) {
                baseName = 'Finlandês';
                flag = '🇫🇮 ';
              } else if (lang.includes('gre') || lang.includes('ell') || lang.includes('el')) {
                baseName = 'Grego';
                flag = '🇬🇷 ';
              } else if (lang.includes('heb') || lang.includes('he')) {
                baseName = 'Hebraico';
                flag = '🇮🇱 ';
              } else {
                baseName = rawTitle || (lang !== 'und' ? lang.toUpperCase() : `Legenda #${s.index}`);
                flag = '💬 ';
              }

              let tag = '';
              if (isCaptions) {
                tag = ' [SDH]';
              } else if (isForced) {
                tag = ' [Forced]';
              } else if (baseName && !baseName.startsWith('Legenda #')) {
                tag = ' [Completo]';
              }

              s.title = `${flag}${baseName}${tag}`;
            });

            // Parsing inteligente do título do arquivo / torrent via @viren070/parse-torrent-title
            const fallbackFilename = extractFilenameFromUrl(targetUrl);
            const rawFileTitle = mediaTitle || fallbackFilename;
            let cleanTitle = rawFileTitle;
            let parsedTorrent: any = null;

            if (rawFileTitle) {
              try {
                parsedTorrent = parseTorrentTitle(rawFileTitle);
                if (parsedTorrent?.title) {
                  let formatted = parsedTorrent.title;
                  if (parsedTorrent.seasons && parsedTorrent.seasons.length > 0) {
                    const s = String(parsedTorrent.seasons[0]).padStart(2, '0');
                    const e =
                      parsedTorrent.episodes && parsedTorrent.episodes.length > 0
                        ? String(parsedTorrent.episodes[0]).padStart(2, '0')
                        : '';
                    formatted += ` S${s}${e ? 'E' + e : ''}`;
                  }
                  if (parsedTorrent.episodeTitle) {
                    formatted += ` - ${parsedTorrent.episodeTitle}`;
                  }
                  cleanTitle = formatted;
                }
              } catch (err) {
                console.warn('[ParseTorrentTitle] Falha ao processar título:', err);
              }
            }

            // Parse da Duração Total da Mídia: Duration: 00:23:45.67, start: ...
            let mediaDuration = 0;
            const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/i);
            if (durationMatch) {
              const h = parseInt(durationMatch[1], 10);
              const m = parseInt(durationMatch[2], 10);
              const s = parseFloat(durationMatch[3]);
              mediaDuration = h * 3600 + m * 60 + s;
            }

            const result = {
              title: cleanTitle,
              rawTitle: rawFileTitle,
              parsedTorrent,
              duration: mediaDuration,
              audios,
              subtitles,
              chapters,
              fonts,
              streamUrl,
            };
            tracksCache.set(targetUrl, result);

            // Pré-extração não-bloqueante em background das faixas em português (tanto Forced quanto Completo) e forçadas (und)
            const ptSubs = subtitles.filter(
              (s: any) =>
                s.language?.toLowerCase().includes('por') ||
                s.language?.toLowerCase().includes('pt') ||
                s.title?.toLowerCase().includes('portugu') ||
                s.title?.toLowerCase().includes('brasil') ||
                s.title?.toLowerCase().includes('brazil') ||
                (s.isForced && (s.language === 'und' || !s.language))
            );

            const subsToPreExtract = ptSubs.length > 0 ? ptSubs : (subtitles[0] ? [subtitles[0]] : []);

            for (const pSub of subsToPreExtract) {
              if (pSub && pSub.index !== undefined) {
                const subTrackIdx = String(pSub.index);
                const subHash = getMediaFingerprint(targetUrl);
                const subCacheFile = path.join(SUB_CACHE_DIR, `${subHash}_s${subTrackIdx}.ass`);
                if (!fs.existsSync(subCacheFile)) {
                  console.log(`[Tracks] 🚀 Pré-extraindo legenda prioritária #${subTrackIdx} (${pSub.title}) em background para o cache...`);
                  getOrExtractSubtitle(targetUrl, subTrackIdx).catch((e) => {
                    console.warn(`[Tracks] Pré-extração de legenda deferida:`, e.message);
                  });
                }
              }
            }

            console.log(`[Tracks] 🎬 Título: "${cleanTitle}" | Duração: ${mediaDuration.toFixed(1)}s | Original: "${rawFileTitle}"`);
            console.log(`[Tracks] Detectados ${audios.length} áudios, ${subtitles.length} legendas, ${chapters.length} capítulos e ${fonts.length} fontes embutidas via FFmpeg.`);
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(JSON.stringify(result));
          } catch (err: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: err.message, stderr }));
          }
        });
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message }));
      }
    });

    // 4. Endpoint Subtitle: Extração sob demanda resiliente com deduplicação, timeout e persistência contínua
    server.middlewares.use('/api/subtitle', async (req, res) => {
      let track: string | null = null;
      try {
        const reqUrl = new URL(req.url || '', 'http://localhost');
        const targetUrl = reqUrl.searchParams.get('url');
        track = reqUrl.searchParams.get('track');
        const customFingerprint = reqUrl.searchParams.get('fingerprint') || undefined;

        if (!targetUrl || !track) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Missing url or track parameter' }));
          return;
        }

        // A extração continua em background mesmo se o cliente desconectar momentaneamente, garantindo que o arquivo fique no cache
        const content = await getOrExtractSubtitle(targetUrl, track, customFingerprint);

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(content);
      } catch (e: any) {
        console.warn(`[Subtitle] Falha na extração da faixa #${track || 'unknown'}:`, e.message);
        const statusCode = e?.code === 'BITMAP_NOT_SUPPORTED' ? 415 : 422;
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(JSON.stringify({
          error: e?.message || 'Subtitle extraction failed',
          code: e?.code || 'EXTRACTION_FAILED',
        }));
      }
    });

    // 5. Endpoint Font: Extração sob demanda e cache local de fontes anexadas no container MKV
    server.middlewares.use('/api/font', async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '', 'http://localhost');
        const targetUrl = reqUrl.searchParams.get('url');
        const fontFilename = reqUrl.searchParams.get('name') || '';
        const streamTrack = reqUrl.searchParams.get('track');
        const customFingerprint = reqUrl.searchParams.get('fingerprint') || undefined;

        if (!targetUrl || (!fontFilename && !streamTrack)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing url and name/track parameter' }));
          return;
        }

        const hash = getMediaFingerprint(targetUrl, customFingerprint);
        const targetDir = path.join(FONT_CACHE_DIR, hash);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        const extractedMarker = path.join(targetDir, '.extracted');

        // Se já existirem fontes extraídas de sessões anteriores, marca como extraído
        if (!fs.existsSync(extractedMarker) && fs.existsSync(targetDir)) {
          try {
            const existingFiles = fs.readdirSync(targetDir);
            if (existingFiles.some((f) => /\.(ttf|otf|woff2|ttc)$/i.test(f))) {
              fs.writeFileSync(extractedMarker, new Date().toISOString());
            }
          } catch {
            // ignore
          }
        }

        const safeFilename = path.basename(fontFilename || `font_${streamTrack}.ttf`);
        const cacheFile = path.join(targetDir, safeFilename);

        const serveCachedFont = (filePath: string) => {
          const ext = path.extname(filePath).toLowerCase();
          const mime = ext === '.otf' ? 'font/otf' : (ext === '.woff2' ? 'font/woff2' : 'font/ttf');
          res.setHeader('Content-Type', mime);
          res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
          res.setHeader('Access-Control-Allow-Origin', '*');
          fs.createReadStream(filePath).pipe(res);
        };

        const tryFindAndServe = (): boolean => {
          // 1. Arquivo com nome exato
          if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 100) {
            serveCachedFont(cacheFile);
            return true;
          }
          // 2. Arquivo com case diferente ou extensão normalizada
          if (fs.existsSync(targetDir)) {
            const files = fs.readdirSync(targetDir);
            const matched = files.find((f) => f.toLowerCase() === safeFilename.toLowerCase());
            if (matched) {
              const matchedPath = path.join(targetDir, matched);
              if (fs.statSync(matchedPath).size > 100) {
                serveCachedFont(matchedPath);
                return true;
              }
            }
          }
          return false;
        };

        // 1. Se já está no cache local
        if (tryFindAndServe()) {
          return;
        }

        // 2. Se o container já foi totalmente extraído, não roda FFmpeg de novo
        if (fs.existsSync(extractedMarker)) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify({ error: 'Fonte não encontrada no container MKV' }));
          return;
        }

        // 3. Deduplica extrações de fonte simultâneas para a mesma mídia
        if (pendingFontExtractions.has(hash)) {
          await pendingFontExtractions.get(hash);
          if (tryFindAndServe()) {
            return;
          }
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify({ error: 'Fonte não encontrada no container MKV' }));
          return;
        }

        const extractionPromise = (async () => {
          const streamUrl = await resolveFinalCdnUrl(targetUrl);
          console.log(`[FontExtractor] 🔤 Extraindo fontes anexadas do MKV (Media: ${hash})...`);

          return new Promise<void>((resolve, reject) => {
            // Executa FFmpeg com -dump_attachment:t "" para extrair todas as fontes para o diretório targetDir de uma só vez
            const args = [
              '-hide_banner',
              '-v', 'error',
              '-y',
              '-reconnect', '1',
              '-reconnect_at_eof', '1',
              '-reconnect_streamed', '1',
              '-reconnect_delay_max', '5',
              '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n',
              '-dump_attachment:t', '',
              '-i', streamUrl,
            ];

            const proc = spawn(FFMPEG_PATH, args, { cwd: targetDir });

            proc.on('close', () => {
              // Marca o diretório como inspecionado/extraído para nunca mais reexecutar FFmpeg
              try {
                fs.writeFileSync(extractedMarker, new Date().toISOString());
              } catch {
                // ignore
              }
              resolve();
            });

            proc.on('error', (err) => {
              reject(err);
            });
          });
        })();

        pendingFontExtractions.set(hash, extractionPromise);

        try {
          await extractionPromise;
        } finally {
          pendingFontExtractions.delete(hash);
        }

        if (tryFindAndServe()) {
          return;
        }

        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(JSON.stringify({ error: 'Fonte não encontrada no container MKV' }));
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  };

  return {
    name: 'media-stream-proxy',
    configureServer: setup,
    configurePreviewServer: setup,
  };
}

const customViteLogger = createLogger();
const originalLoggerWarn = customViteLogger.warn;
customViteLogger.warn = (msg, options) => {
  if (
    msg.includes('points to missing source files') ||
    msg.includes('jassub-worker') ||
    msg.includes('SOURCEMAP_ERROR')
  ) {
    return;
  }
  originalLoggerWarn(msg, options);
};

export default defineConfig(() => {
  return {
    customLogger: customViteLogger,
    plugins: [react(), tailwindcss(), mediaProxyPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        throughput: path.resolve(__dirname, 'src/throughput-shim.js'),
      },
    },
    optimizeDeps: {
      exclude: ['jassub'],
    },
    worker: {
      format: 'es' as const,
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      allowedHosts: true as const,
      cors: true,
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: {
        ignored: [
          '**/.cache/**',
          '**/cache/**',
          '**/*.ass',
          '**/*.srt',
          '**/*.vtt',
          '**/*.txt',
          '**/*.log',
          '**/log*',
          '**/log*.txt',
          '**/.git/**',
          '**/node_modules/**',
        ],
      },
    },
    preview: {
      port: 3000,
      host: '0.0.0.0',
      allowedHosts: true as const,
      cors: true,
    },
  };
});
