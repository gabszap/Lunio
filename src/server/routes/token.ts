import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { sendApiError } from '../http';

/** POST /api/token — troca o código OAuth2 da Discord Activity pelo access_token. */
export async function handleToken(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 8192) req.destroy();
  });
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
        const envPath = path.resolve(config.rootDir, '.env');
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
      res.end(JSON.stringify(tokenData));
    } catch (err: any) {
      console.error('[Discord Auth] Erro na troca do código:', err?.message);
      sendApiError(res, 500, 'internal');
    }
  });
}
