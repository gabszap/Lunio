# Architecture and API

**English** · [Português](architecture.pt-BR.md) · ← [Back to the README](../README.md)

## How it works

```
Browser (React + Vidstack)
   │  HTTP  ── /api/proxy, /api/tracks, /api/subtitle, /api/upload …
   │  WebSocket ── /api/ws (rooms, sync, chat)
   ▼
Backend: Express router (src/server/app.ts), served by src/server/main.ts in production
or plugged into the Vite dev/preview server (vite.config.ts)
   ├─ media proxy: HTTP Range passthrough, FFmpeg fMP4 remux for alternate audio
   ├─ track inspection and subtitle/font extraction (FFmpeg + mkv_extractor)
   ├─ uploads (.uploads/) and Google Drive resolver
   └─ room server (src/server/roomServer.ts)
```

### API routes

| Route | Description |
|---|---|
| `GET /api/proxy?url=` | Streams a remote video (Range support). With `audio=` it remuxes to fMP4 with that audio track |
| `POST /api/hls/start`, `GET /api/hls/<id>/<audio>/index.m3u8`, `GET /api/hls/<id>/<audio>/<n>.ts` | Shared HLS for an alternate audio track: playlist and ~6 s segments generated on demand and cached (MKV with Cues + H.264 only; otherwise `start` answers 501 and the player uses the remux) |
| `GET /api/tracks?url=` | Audio, subtitle, chapter and font tracks of a file |
| `GET /api/subtitle?url=&track=` | Extracts an embedded subtitle (cached in `.cache/subtitles`) |
| `GET /api/font?url=&track=` | Extracts an embedded font. Fonts are stored once per content (hardlinks in `.cache/fonts/_shared`), so episodes of the same group share them |
| `GET /api/fontmap?url=` | The names each embedded font can be requested by (family, full, PostScript). The player loads only the fonts the subtitle uses instead of all ~24 attached to the MKV |
| `GET /api/resolve?url=` | Resolves Torrentio/debrid redirects to the final CDN URL |
| `GET /api/upstream?url=` | Whether the video's provider (or its CDN) rate-limited the server just now (429). The player asks on a playback error to say "the provider limited the requests". Makes no request to the provider |
| `GET /api/catalog/manifest`, `/row`, `/search`, `/meta` | The catalog (rows, search, details) from the configured source (`CATALOG_URL`, default Cinemeta), cached on the server; if the source is down it serves the last saved answer (`stale: true`). The source URL never reaches the browser |
| `GET /api/room?id=` | Whether a room exists or was closed |
| `POST /api/upload/start`, `PUT /api/upload/<id>?offset=`, `POST /api/upload/<id>/finish`, `DELETE /api/upload/<id>` | Chunked, resumable upload (up to 50 GB) into `.uploads/`. Chunks are 64 MB by default so each request stays under proxies that cap the body (Cloudflare's free plan allows 100 MB) |
| `POST /api/uploads/claim`, `POST /api/uploads/status` | Reopen a recent upload in a new room, and check whether it is still on the server |
| `GET /api/uploads/<id>/<name>` | Serves an uploaded file with Range support |
| `GET /api/drive?url=` | Resolves a Google Drive share link to a playable URL |
| `POST /api/session` | Session token for watching alone (room members get theirs over the WebSocket). The media routes require it |
| `POST /api/screen/token` | Relay address with the right token for the caller: publish for the Host who is streaming, watch-only for everyone else (and only once the broadcast is live). Room members only, rate limited, never cached |
| `GET /api/status` | Whether FFmpeg and Python were found (versions only), rooms and people online, uptime, cache and Redis state, and the screen sharing numbers (on/off, live broadcasts, bytes sent by Hosts, estimated relay egress) |
| `POST /api/token` | Discord OAuth2 code exchange |
| `WS /api/ws` | Rooms: membership, playback sync, chat, moderation, and the `screen:*` messages of screen sharing (the encryption key travels here, only to the people in the room) |

Empty rooms are closed about 30 seconds after the last person leaves (`EMPTY_ROOM_TTL_MS` in `src/server/roomServer.ts`). A room restored from Redis that nobody comes back to closes after the host's 60 s grace plus those 30 seconds.

## Project structure

```
src/
  App.tsx                   Screens: Home (catalog, room, status) and player
  components/
    home/                   Room menu, source steps (stream, upload, YouTube, Drive, join), last room, Status tab
    catalog/                Catalog rows, search, Explore, title page, addons and streams list
    player/                 The player's hooks (room sync, alternate audio, subtitles, controls, shortcuts…),
                            overlays and the screen sharing stage
    VideoPlayer.tsx         Player composition (Vidstack)
    PlayerControls.tsx      Controls bar and menus
    WatchPartyPanel.tsx     Chat and participants
    ui.tsx                  Shared UI primitives (design system)
  lib/                      Room client (sync.ts), subtitles, media helpers, catalog, addons, continue watching
    screen/                 Screen sharing engine: capture, encode, encrypt, MoQ transport, playout
  server/                   Backend, independent of Vite
    app.ts / main.ts        API router / production entry point
    routes/                 One file per endpoint
    media/                  Proxy, tracks, subtitles, fonts, HLS, remux, uploads, cache
    roomServer.ts           Rooms: sync, chat, queue, Host, screen sharing state
    roomStore.ts            Rooms saved in Redis
  types/                    Types shared by the client and the server
mkv_extractor/              Python extractor for subtitles and keyframes inside remote MKV files (HTTP Range)
e2e/                        Playwright end-to-end tests (production server + local MKV fixture)
tests/                      Python tests (mkv_extractor)
docs/                       Technical documentation
public/                     Static files: JASSUB (libass), fallback fonts, Sintel sample
assets/                     README images (readme/) and Discord art (discord/)
DESIGN.md                   Design system notes
```
