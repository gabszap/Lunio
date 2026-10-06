<p align="center">
  <img src="docs/banner-en.webp" alt="Lunio — watch together, perfectly in sync" width="100%">
</p>

# Lunio

**English** · [Português](README.pt-BR.md)

Lunio is a web video player built for watching together. Paste a stream link, upload a file or open a YouTube/Google Drive video, create a room, and everyone in it watches in sync — with chat, ASS subtitles rendered like a desktop player, alternate audio tracks and chapters. It also runs as a Discord Activity (in development).

## Features

- **Rooms (Watch Party)** — create a room from any source and share an 8-character code or link. The Host controls play, pause, seek and speed; everyone else follows with continuous drift correction. Chat, member list, Host transfer, kick and ban.
- **Video sources**
  - Direct stream links: Stremio, TorBox, and other debrids, `.mkv`/`.mp4`/`.webm`/HLS, proxied through the local server (HTTP Range, CORS bypass).
  - File upload (up to 50 GB) — the room exists while the file uploads. Watching alone plays the file locally without uploading.
  - YouTube videos and lives.
  - Google Drive files shared as "Anyone with the link".
- **MKV support** — audio and subtitle tracks are detected with FFmpeg. Switching to another audio track remuxes the stream to fMP4 on the fly.
- **Subtitles** — embedded ASS/SSA rendered with libass (JASSUB, WebAssembly) including embedded fonts; external `.ass`, `.srt` (converted to WebVTT) and `.vtt` by file or URL; sync offset and font size.
- **Player** — chapter-segmented timeline, "Skip intro/outro" for detected chapters, playback speed, audio delay, volume boost, aspect modes, picture-in-picture, resume where you left off, keyboard shortcuts.
- **Catalog** — browse and search movies and series (metadata from Stremio's public Cinemeta addon), with seasons, episodes and a personal list. The catalog only provides metadata: to watch, you still pick a video source.
- **Status page** — checks the local server, the catalog and your current room.

## Screenshots

| Home | Player |
|---|---|
| ![Home: create a room from a file, YouTube, Google Drive or a stream link](docs/home.webp) | ![Player with chapter timeline and controls](docs/player.webp) |

<sub>Video in the screenshots: *Sintel* © Blender Foundation, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).</sub>

## Requirements

| Tool | Needed for | Notes |
|---|---|---|
| Node.js 20+ | Everything | |
| FFmpeg | Track detection, audio track switching, subtitle extraction fallback | Looked up at `C:\Program Files\mpv\ffmpeg.exe`, then `C:\ffmpeg\ffmpeg.exe`, then `ffmpeg` on the `PATH` |
| Python 3.10+ | Fast embedded subtitle extraction (`mkv_extractor`) | Standard library only. Without it, subtitles fall back to FFmpeg (slower). Set `PYTHON_PATH` if `python` isn't on the `PATH` |

## Getting started

```bash
npm install
npm run dev      # development (hot reload)
npm start        # production: builds, then serves the optimized build
```

Open <http://localhost:3000>. The dev server also listens on your local network, so friends on the same network can join using your machine's IP.

### Environment variables

Copy `.env.example` to `.env` (only needed for the Discord Activity):

| Variable | Description |
|---|---|
| `VITE_DISCORD_CLIENT_ID` | Discord application ID used by the Activity |
| `DISCORD_CLIENT_SECRET` | Discord application secret, used by `/api/token` for the OAuth2 exchange |
| `PYTHON_PATH` | *(optional)* Python interpreter for the subtitle extractor |
| `DISABLE_HMR` | *(optional)* `true` disables Vite hot reload |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development: app + API + WebSocket on port 3000, with hot reload |
| `npm start` | Production: builds into `dist/`, then serves it with the API and WebSocket on port 3000 |
| `npm run build` | Builds the frontend into `dist/` |
| `npm run preview` | Serves an existing `dist/` build with the API and WebSocket (no rebuild) |
| `npm run lint` | Type-checks the project (`tsc --noEmit`) |
| `python -m pytest tests` | Runs the `mkv_extractor` tests |

> The backend (media proxy, uploads, rooms) is a Vite plugin registered in both the dev server and the preview server, so `npm start` runs the full app from the optimized build: minified, no hot reload and no source files exposed. Use `npm run dev` only while developing.

## How it works

```
Browser (React + Vidstack)
   │  HTTP  ── /api/proxy, /api/tracks, /api/subtitle, /api/upload …
   │  WebSocket ── /api/ws (rooms, sync, chat)
   ▼
Vite server, dev or preview (vite.config.ts)
   ├─ media proxy: HTTP Range passthrough, FFmpeg fMP4 remux for alternate audio
   ├─ track inspection and subtitle/font extraction (FFmpeg + mkv_extractor)
   ├─ uploads (.uploads/) and Google Drive resolver
   └─ room server (src/server/roomServer.ts)
```

### API routes

| Route | Description |
|---|---|
| `GET /api/proxy?url=` | Streams a remote video (Range support). With `audio=` it remuxes to fMP4 with that audio track |
| `GET /api/tracks?url=` | Audio, subtitle, chapter and font tracks of a file |
| `GET /api/subtitle?url=&track=` | Extracts an embedded subtitle (cached in `.cache/subtitles`) |
| `GET /api/font?url=&track=` | Extracts an embedded font |
| `GET /api/resolve?url=` | Resolves Torrentio/debrid redirects to the final CDN URL |
| `GET /api/room?id=` | Whether a room exists or was closed |
| `POST /api/upload?name=` | Uploads a file (raw body, up to 50 GB) into `.uploads/` |
| `GET /api/uploads/<id>/<name>` | Serves an uploaded file with Range support |
| `GET /api/drive?url=` | Resolves a Google Drive share link to a playable URL |
| `POST /api/token` | Discord OAuth2 code exchange |
| `WS /api/ws` | Rooms: membership, playback sync, chat, moderation |

Empty rooms are closed about 30 seconds after the last person leaves (`EMPTY_ROOM_TTL_MS` in `src/server/roomServer.ts`).

## Project structure

```
src/
  App.tsx                 Screens: Home (catalog, room, status) and player
  components/
    home/                 Room menu and source steps (stream, upload, YouTube, Drive, join)
    catalog/              Catalog, search and title details
    VideoPlayer.tsx       Player core (Vidstack), sync, overlays
    PlayerControls.tsx    Controls bar and menus
    WatchPartyPanel.tsx   Chat and participants
    ui.tsx                Shared UI primitives (design system)
  lib/                    Sync client, subtitles, media helpers, catalog, Discord
  server/                 Room server and upload/Drive routes
mkv_extractor/            Python extractor for subtitles inside remote MKV files (HTTP Range)
public/                   Static files: JASSUB (libass), fallback fonts, Sintel sample
docs/                     README images
DESIGN.md                 Design system notes
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / pause |
| `J` / `←` · `L` / `→` | Back / forward 10 s |
| `N` / `O` | Skip intro (+90 s, or to the end of a detected intro/outro) |
| `↑` / `↓` | Volume ±5% |
| `M` | Mute |
| `C` | Toggle subtitles |
| `G` / `H` | Subtitle sync ±50 ms (`Shift` for ±250 ms) |
| `[` / `]` | Audio delay ±50 ms |
| `Z` | Aspect mode |
| `F` | Fullscreen |
| `W` | Watch Party panel |

## Known limitations

- Torrent links and screen sharing appear in the menu as "Coming soon"; they need a torrent engine and WebRTC on the server.
- Uploaded files stay in `.uploads/` until you delete them.
- A ban applies to the browser tab's identity; a new tab or another browser gets a new identity.
