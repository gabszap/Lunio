import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendApiError, sendJson } from '../http';
import { readText, safeRequest, UrlBlockedError, type SafeResponse } from '../security';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function getDriveFileId(link: string): string | null {
  const trimmed = (link || '').trim();
  const byPath = /\/(?:file\/)?d\/([\w-]{10,})/.exec(trimmed);
  if (byPath) return byPath[1];
  try {
    const u = new URL(trimmed);
    const id = u.searchParams.get('id');
    if (id && /^[\w-]{10,}$/.test(id)) return id;
  } catch {
    // não é URL
  }
  return /^[\w-]{25,}$/.test(trimmed) ? trimmed : null;
}

const header = (r: SafeResponse, name: string): string | null => {
  const v = r.headers[name];
  return Array.isArray(v) ? v[0] : v ?? null;
};

function parseSize(contentRange: string | null, contentLength: string | null): number {
  const total = contentRange ? /\/(\d+)$/.exec(contentRange) : null;
  if (total) return Number(total[1]);
  return Number(contentLength || 0);
}

function parseFileName(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return null;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1] : null;
}

async function probe(url: string) {
  const r = await safeRequest(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-0' } });
  return { r, type: header(r, 'content-type') || '', finalUrl: r.url };
}

export async function handleDrive(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '', 'http://localhost');
  const id = getDriveFileId(url.searchParams.get('url') || '');
  if (!id) {
    sendApiError(res, 400, 'bad_request', 'Link do Drive inválido.');
    return;
  }

  try {
    let downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download`;
    let { r, type, finalUrl } = await probe(downloadUrl);

    const noAccess = () => /accounts\.google\.com|ServiceLogin/.test(finalUrl) || r.status === 401 || r.status === 403 || r.status === 404;

    if (!noAccess() && type.includes('text/html')) {
      // Arquivos grandes: o Drive mostra a página "não foi possível verificar vírus" com um formulário de confirmação
      const html = await readText(r.body);
      const field = (n: string) => new RegExp(`name="${n}"\\s+value="([^"]*)"`).exec(html)?.[1];
      const confirm = field('confirm');
      const uuid = field('uuid');
      if (!confirm) {
        sendApiError(res, 403, 'forbidden', 'O arquivo não está compartilhado com acesso por link.');
        return;
      }
      downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=${encodeURIComponent(confirm)}${
        uuid ? `&uuid=${encodeURIComponent(uuid)}` : ''
      }`;
      ({ r, type, finalUrl } = await probe(downloadUrl));
    } else {
      r.body.destroy();
    }

    if (noAccess() || type.includes('text/html') || r.status >= 400) {
      r.body.destroy();
      sendApiError(res, 403, 'forbidden', 'O arquivo não está compartilhado com acesso por link.');
      return;
    }
    r.body.destroy();

    sendJson(res, 200, {
      id,
      url: downloadUrl,
      name: parseFileName(header(r, 'content-disposition')) || `drive-${id}`,
      size: parseSize(header(r, 'content-range'), header(r, 'content-length')),
      mimeType: type.split(';')[0] || 'video/mp4',
    });
  } catch (err) {
    if (err instanceof UrlBlockedError) {
      sendApiError(res, 403, 'url_blocked');
      return;
    }
    console.warn('[Drive] Falha ao consultar o Google Drive:', (err as Error)?.message);
    sendApiError(res, 502, 'upstream_failed', 'Não foi possível falar com o Google Drive.');
  }
}
