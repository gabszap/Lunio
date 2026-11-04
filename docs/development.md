# Development and testing

**English** · [Português](development.pt-BR.md) · ← [Back to the README](../README.md)

## Requirements

| Tool | Needed for | Notes |
|---|---|---|
| Node.js 20+ | Everything | |
| FFmpeg | Track detection, audio track switching, subtitle extraction fallback | `FFMPEG_PATH`, then `ffmpeg` on the `PATH`, then known Windows paths (mpv, `C:\ffmpeg`) |
| Python 3.10+ | Fast embedded subtitle extraction (`mkv_extractor`) | Standard library only. Found as `PYTHON_PATH`, `python3`, `python` or `py -3`. Without it, subtitles fall back to FFmpeg (slower) |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development: app + API + WebSocket on port 3000, with hot reload |
| `npm start` | Production: `npm run build`, then `npm run serve` |
| `npm run serve` | Production server (`src/server/main.ts`): Express serving `dist/` + API + WebSocket on `PORT` (default 3000), without Vite. Needs a previous `npm run build` |
| `npm run build` | Builds the frontend into `dist/` |
| `npm run preview` | Vite's preview of an existing `dist/` with the API plugged in (handy for quick checks; production uses `serve`) |
| `npm run lint` | Type-checks the project (`tsc --noEmit`) |
| `npm test` | Vitest: room server (join/leave, Host authority, kick/ban, empty rooms) and API routes (SSRF, uploads/quota, Range, subtitle errors). Needs FFmpeg for the media routes. Tests against a real Redis run only with `REDIS_TEST_URL` set |
| `npm run test:e2e` | Builds, then Playwright E2E against the production server with a local FFmpeg-generated MKV (two users in one room, sync, kick/ban, alternate audio, Host reload). First time: `npx playwright install chromium` |
| `python -m pytest tests` | Runs the `mkv_extractor` tests |

> The backend lives in `src/server/` and is independent of Vite: `npm run serve` runs it as a plain Express app, and `npm run dev` / `npm run preview` just plug the same router into Vite. In development, editing a server file restarts the dev server (and drops open rooms); in production nothing watches the code. With `REDIS_URL` set, rooms survive a restart or deploy (host, bans, queue, video and position are restored; the previous host has 60 s to come back before someone else takes over); without it, rooms drop on a restart.

## Development on Windows

Everything runs on Windows without extra setup: `npm install` then `npm run dev`. FFmpeg is looked up in this order: `FFMPEG_PATH` → `ffmpeg` on the `PATH` → `C:\Program Files\mpv\ffmpeg.exe` → `C:\ffmpeg\ffmpeg.exe`. Python: `PYTHON_PATH` → `python3` → `python` → `py -3`. The server prints what it found when it starts, and **Status** shows it too. To run a second copy beside `npm run dev`, use `npx vite --port=3001 --strictPort`.
