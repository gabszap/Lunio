# Configuration

**English** · [Português](configuration.pt-BR.md) · ← [Back to the README](../README.md)

Copy `.env.example` to `.env`. Locally nothing is required (only the Discord Activity needs the first two); on a server set at least `SESSION_SECRET` and `TRUST_PROXY`. Variables already in the environment (systemd, Docker) win over the file.

| Variable | Description |
|---|---|
| `VITE_DISCORD_CLIENT_ID` | Discord application ID used by the Activity |
| `DISCORD_CLIENT_SECRET` | Discord application secret, used by `/api/token` for the OAuth2 exchange |
| `SESSION_SECRET` | Signs the session tokens. Without it a new one is generated at each start |
| `ALLOWED_ORIGINS` | Extra origins (comma separated) allowed to call the API and open the WebSocket. Default: same origin + the Discord Activity |
| `TRUST_PROXY` | `1` behind Caddy/nginx: the client IP (used for rate limits) comes from `X-Forwarded-For` |
| `FFMPEG_PATH` | *(optional)* FFmpeg executable. Otherwise `ffmpeg` on the `PATH`, then known Windows paths |
| `PYTHON_PATH` | *(optional)* Python 3.10+ for the subtitle extractor. Otherwise `python3`, `python`, `py -3` |
| `MAX_UPLOAD_DISK_GB` / `MAX_UPLOAD_FILE_GB` | Disk quota for uploads (default 20) and size limit per upload (default 50) |
| `UPLOAD_TTL_HOURS` | Hours an upload is kept after its room closes (default 24) |
| `REDIS_URL` | *(optional)* A local Redis, e.g. `redis://127.0.0.1:6379`. Rooms then survive a restart and the upload index is kept in it. See [Redis](deployment.md#optional-redis) |
| `ROOM_STATE_TTL_HOURS` / `ROOM_HOST_GRACE_SECONDS` | With Redis: how long a room's saved state is valid (default 24) and how long the previous host has to come back after a restart before someone else takes over (default 60) |
| `UPLOAD_IDLE_HOURS` | Hours an upload in an open room may go unread before it is removed (default 24) |
| `MIN_FREE_DISK_GB` | Free space to keep on the machine's disk; uploads are refused below it (default 5) |
| `CATALOG_URL` | *(optional)* Stremio addon that feeds the catalog: the install URL or base of an [AIOMetadata](https://github.com/cedya77/aiometadata) (`https://…/stremio/<uuid>/<config>/manifest.json`, `stremio://…` also works), or any addon with catalogs. Empty = Cinemeta. Keep it only in the server `.env`: it carries your config and keys |
| `JIKAN_URL` | *(optional)* API of the MyAnimeList score shown on anime pages: a Jikan-compatible instance (`GET <base>/anime/<id>` with `data.score`), base with the version prefix. The official Jikan API was shut down, so use a third-party public instance or your own. Empty = the default public instance (jikan-edge). The score is requested apart from the page (3 tries on the server, then the browser tries again), cached for 24 h; without an answer the page just omits it. Anime found by IMDb id are matched to their MyAnimeList id through the source's anime search |
| `MAX_CACHE_GB` | Limit for `.cache/` (default 10, includes the HLS segments); the least recently used is deleted first |
| `MAX_FFMPEG_PROCS` | FFmpeg/Python processes at once (default 8) |
| `FFMPEG_THROUGHPUT_MBPS` | Starting guess (default 40) of how fast FFmpeg reads a CDN, used to choose between the subtitle extractor and reading the whole file. After real reads, the server uses the measured average per CDN host |
| `SCREEN_SHARE_ENABLED` | *(optional)* `1` turns screen sharing on. It also needs the three variables below; without them it stays off. See [Screen sharing](screen-sharing.md#screen-sharing) |
| `MOQ_RELAY_URL` / `MOQ_TOKEN_PUBLISH` / `MOQ_TOKEN_SUBSCRIBE` | The MoQ relay (`https://…`, no token in it) and its two tokens: one that can publish (only ever handed to the Host who is streaming) and one that can only watch. **Secrets**: keep them in the server `.env` only |
| `SCREEN_SHARE_MAX_LIVE` | Rooms that may stream at once (default 10). The relay is in beta and does not meter or bill yet, so the cap is ours |
| `ALLOW_PRIVATE_URLS` | Local tests only: lets the proxy reach private network addresses. Keep empty in production |
| `DISABLE_HMR` | *(optional)* `true` disables Vite hot reload |
