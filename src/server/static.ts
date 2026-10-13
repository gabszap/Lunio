import express from 'express';
import path from 'node:path';

/**
 * Arquivos estáticos do frontend (`dist/`) e fallback do SPA.
 *
 * O fallback devolve o `index.html` para as rotas do app (`/`, `/sala/abc`…). Ele NÃO pode atender
 * pedidos de arquivo: `/.env`, `/.git/config`, `/backup.sql` ou um `/assets/sumiu.js` voltavam
 * 200 com o HTML da home, o que não vaza nada, mas confunde scanners, caches e o próprio navegador
 * (que tentava executar HTML como JavaScript). Aqui esses casos viram 404.
 */

/** Decodifica o caminho da URL; `null` se estiver malformado ou tiver byte nulo. */
function decodedSegments(urlPath: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  return decoded.split(/[\\/]+/).filter(Boolean);
}

/**
 * Caminho interno: qualquer segmento começando com ponto (`.env*`, `.git/*`, `.htaccess`, `..`).
 * Sem exceções: o ACME do Caddy é respondido pelo próprio Caddy e o Lunio não publica nada em `/.well-known/`.
 * Se um dia precisar (ex.: security.txt), a exceção entra aqui, com `dotfiles` liberado só para essa pasta.
 */
export function isInternalPath(urlPath: string): boolean {
  const segments = decodedSegments(urlPath);
  if (!segments) return true;
  return segments.some((seg) => seg.startsWith('.'));
}

/** O último segmento tem extensão (`x.js`, `dump.sql`): é pedido de arquivo, não rota do SPA. */
export function looksLikeFileRequest(urlPath: string): boolean {
  const segments = decodedSegments(urlPath);
  const last = segments?.[segments.length - 1] ?? '';
  return last.includes('.');
}

function notFound(res: express.Response) {
  res.status(404).setHeader('Cache-Control', 'no-store').type('text/plain').send('Not found');
}

export function mountStatic(app: express.Express, dist: string) {
  const indexHtml = path.join(dist, 'index.html');

  app.use((req, res, next) => {
    if (isInternalPath(req.path)) return notFound(res);
    next();
  });

  app.use(
    express.static(dist, {
      index: false,
      dotfiles: 'ignore',
      setHeaders(res, file) {
        // Arquivos com hash no nome (assets/) nunca mudam; o resto revalida
        res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    })
  );

  // SPA: rota sem extensão abre o app; pedido de arquivo que o static não achou é 404
  app.get('*', (req, res) => {
    if (looksLikeFileRequest(req.path)) return notFound(res);
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
}
