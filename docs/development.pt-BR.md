# Desenvolvimento e testes

[English](development.md) · **Português** · ← [Voltar ao README](../README.pt-BR.md)

## Requisitos

| Ferramenta | Usada para | Observações |
|---|---|---|
| Node.js 20+ | Tudo | |
| FFmpeg | Detecção de faixas, troca de faixa de áudio, extração de legendas (fallback) | `FFMPEG_PATH`, depois `ffmpeg` no `PATH`, depois caminhos conhecidos do Windows (mpv, `C:\ffmpeg`) |
| Python 3.10+ | Extração rápida de legendas embutidas (`mkv_extractor`) | Só biblioteca padrão. Procurado como `PYTHON_PATH`, `python3`, `python` ou `py -3`. Sem ele, as legendas usam o FFmpeg (mais lento) |

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Desenvolvimento: app + API + WebSocket na porta 3000, com hot reload |
| `npm start` | Produção: `npm run build` e depois `npm run serve` |
| `npm run serve` | Servidor de produção (`src/server/main.ts`): Express servindo `dist/` + API + WebSocket em `PORT` (padrão 3000), sem Vite. Precisa de um `npm run build` antes |
| `npm run build` | Gera o frontend em `dist/` |
| `npm run preview` | Preview do Vite sobre um `dist/` já gerado, com a API plugada (útil para checagens rápidas; produção usa `serve`) |
| `npm run lint` | Checagem de tipos (`tsc --noEmit`) |
| `npm test` | Vitest: servidor de salas (entrar/sair, autoridade do Host, kick/ban, sala vazia) e rotas da API (SSRF, envios/cota, Range, erros de legenda). As rotas de mídia precisam do FFmpeg. Os testes com um Redis de verdade só rodam com `REDIS_TEST_URL` definida |
| `npm run test:e2e` | Faz o build e roda o E2E (Playwright) contra o servidor de produção, com um MKV gerado pelo FFmpeg (dois usuários na sala, sincronia, kick/ban, áudio alternativo, reload do Host). Na primeira vez: `npx playwright install chromium` |
| `python -m pytest tests` | Roda os testes do `mkv_extractor` |

> O backend mora em `src/server/` e não depende do Vite: `npm run serve` roda como um app Express comum, e `npm run dev` / `npm run preview` só plugam o mesmo router no Vite. Em desenvolvimento, editar um arquivo do servidor reinicia o servidor de dev (e derruba as salas abertas); em produção nada observa o código. Com `REDIS_URL`, as salas sobrevivem a um restart ou deploy (Host, bans, fila, vídeo e posição são restaurados; o Host anterior tem 60 s para voltar antes de outra pessoa assumir); sem ele, as salas caem num restart.

## Desenvolvimento no Windows

Tudo roda no Windows sem configuração extra: `npm install` e `npm run dev`. O FFmpeg é procurado nesta ordem: `FFMPEG_PATH` → `ffmpeg` no `PATH` → `C:\Program Files\mpv\ffmpeg.exe` → `C:\ffmpeg\ffmpeg.exe`. O Python: `PYTHON_PATH` → `python3` → `python` → `py -3`. O servidor imprime o que encontrou ao iniciar, e a aba **Status** também mostra. Para rodar uma segunda cópia ao lado do `npm run dev`, use `npx vite --port=3001 --strictPort`.
