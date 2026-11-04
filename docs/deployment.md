# Deploying to a server

**English** · [Português](deployment.pt-BR.md) · ← [Back to the README](../README.md)

A small VPS is enough. Lunio runs as a single Node process (`npm run serve`); Caddy sits in front for HTTPS and WebSocket, and systemd keeps it running. Replace `lunio.example.com` with your domain (its DNS must point to the server) and open ports 80 and 443.

**1. Install Node 22, FFmpeg, Python and Caddy**

```bash
sudo apt update && sudo apt install -y ffmpeg python3 git curl debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
# Caddy: https://caddyserver.com/docs/install#debian-ubuntu-raspbian
sudo apt install -y caddy
```

Ubuntu's `python3` is 3.12 (Lunio needs 3.10+) and is detected automatically; there is no `python` command and none is needed.

**2. Get the code and configure**

```bash
sudo useradd --system --create-home --home-dir /opt/lunio --shell /usr/sbin/nologin lunio
sudo -u lunio git clone https://github.com/gabszap/Lunio.git /opt/lunio/app
cd /opt/lunio/app
sudo -u lunio npm ci
sudo -u lunio npm run build
sudo -u lunio cp .env.example .env
sudo -u lunio nano .env
```

In `.env` set at least:

```ini
SESSION_SECRET=<output of: openssl rand -hex 32>
TRUST_PROXY=1                              # Caddy is in front: use the real client IP
ALLOWED_ORIGINS=                           # only if the site is served from other origins too
VITE_DISCORD_CLIENT_ID=...                 # only for the Discord Activity
DISCORD_CLIENT_SECRET=...
```

Leave `ALLOW_PRIVATE_URLS` empty. It exists only for local tests and turns off the protection that keeps the server from reaching your internal network.

**3. Build and systemd service** — `/etc/systemd/system/lunio.service`

```ini
[Unit]
Description=Lunio
After=network.target

[Service]
User=lunio
WorkingDirectory=/opt/lunio/app
ExecStart=/usr/bin/npm run serve
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now lunio
journalctl -u lunio -f      # at startup it logs which FFmpeg and Python it found
```

`WorkingDirectory` matters: `.uploads/`, `.cache/`, `dist/` and `.env` live there. `npm run serve` does not build, so run `npm run build` once after each `git pull` (restarts are then instant). `PORT` and `HOST` in `.env` change where it listens (default `0.0.0.0:3000`).

**4. Caddy (HTTPS + WebSocket)** — `/etc/caddy/Caddyfile`

```caddyfile
lunio.example.com {
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
}
```

```bash
sudo systemctl reload caddy
```

Caddy gets the certificate by itself and proxies WebSocket with no extra configuration, so the browser connects to `wss://lunio.example.com/api/ws`. `flush_interval -1` sends the alternate-audio stream to viewers as FFmpeg produces it, with no buffering.

**5. Check**

Open `https://lunio.example.com`, go to **Status**: Server, FFmpeg and Python should all be green. Then create a room, open it in a second browser, and switch an audio track.

**Updating:** `cd /opt/lunio/app && sudo -u lunio git pull && sudo -u lunio npm ci && sudo -u lunio npm run build && sudo systemctl restart lunio`. Without `REDIS_URL`, restarting closes open rooms; with it, they come back.

### Screen sharing

Off by default. It uses **MoQ over WebTransport** through a relay: the Host's browser captures the screen (`getDisplayMedia`), encodes it with WebCodecs (H.264 video, Opus audio) and publishes to the relay; viewers subscribe, decode and draw it, with the audio as the clock. The server only coordinates (who is broadcasting, the quality, the keys) and never touches the video.

To turn it on you need a relay. The default is [Cloudflare's managed MoQ relay](https://developers.cloudflare.com/) (beta): create a relay, then put its URL and its two default tokens in `.env` and set the flag:

```bash
SCREEN_SHARE_ENABLED=1
MOQ_RELAY_URL=https://<your relay>
MOQ_TOKEN_PUBLISH=…
MOQ_TOKEN_SUBSCRIBE=…
```

- **Who can do what.** Only the room's Host starts a broadcast (desktop Chromium; the page asks for the screen and, if the browser offers it, the system audio). The Host's quality choice is final for that broadcast: there is no automatic downgrade. The relay's publish token is only ever given to the Host who is streaming.
- **Privacy.** Every frame is encrypted (AES-GCM) with a key the Host's browser generates, and the server hands that key only to the people in the room right now over the room WebSocket. A relay token cannot be scoped to one broadcast, and revoking it does not drop a connection that is already open, so the encryption is what keeps outsiders out. When someone is kicked, banned or leaves, the Host rotates the key and the people who stay get the new one; the one who left keeps receiving bytes they can no longer decode. Keys are never stored, logged or put in the room state.
- **Browsers.** Hosts: Chrome, Edge or Brave on a computer (a recent version: older ones ignore the option that keeps the room video's own sound out of the shared system audio, so the Host's room video may be heard twice by viewers; sharing a window instead of the whole screen avoids it). Viewers: Chromium browsers and Firefox. Safari and iOS are not supported, and screen sharing is off inside the Discord Activity.
- **Cost.** The relay is in beta and has no price or meter yet. The server counts what the Hosts send and estimates the egress (bytes × viewers): **Status** shows it, and the numbers are kept per day in Redis when Redis is on. For scale, 1080p60 is up to 10 Mbps, about 4.5 GB per hour *per viewer*. `SCREEN_SHARE_MAX_LIVE` caps simultaneous broadcasts. If the managed relay ever becomes a problem, the transport sits behind an interface, so a self-hosted `moq-relay` (or another provider) can replace it without touching the rest.
- **Limits.** A broadcast ends with its Host (Host change, leaving, closing the page or a restart). It is memory-only and never saved to Redis. 60 fps depends on the Host's machine: some computers only capture about 30 fps even when asked for 60.

### Optional: Redis

Lunio runs fine without Redis. With it, **rooms survive a restart or deploy**: the host, bans, queue, current video and position are saved and restored before the server accepts connections, and the previous host gets 60 s to come back (anyone reconnecting sooner joins as a viewer). Without it, a restart closes every open room. Chat and who is connected are never saved. Redis also keeps the upload index (last read, rooms, closed marks), which is rebuilt from disk on every start, and the catalog responses (so a restart does not start the catalog source from cold).

Redis is never the source of truth and never blocks the server: each call has a 300 ms ceiling and falls back silently (one log warning per minute). It holds no secrets worth persisting, so run it **in RAM only and bound to localhost**:

This uses Docker; without it, `sudo apt install redis-server` works too, as long as it listens only on `127.0.0.1` and you disable persistence (`save ""`, `appendonly no`).

```bash
docker run -d --name lunio-redis --restart unless-stopped -p 127.0.0.1:6379:6379 redis:8-alpine \
  redis-server --save "" --appendonly no --maxmemory 128mb --maxmemory-policy volatile-ttl
```

Then add `REDIS_URL=redis://127.0.0.1:6379` to `/opt/lunio/app/.env` and `sudo systemctl restart lunio`. **Status** shows "Redis: connected" when it works. Never expose the port publicly.

## Optional: Redis

Lunio runs fine without Redis. With it, **rooms survive a restart or deploy**: the host, bans, queue, current video and position are saved and restored before the server accepts connections, and the previous host gets 60 s to come back (anyone reconnecting sooner joins as a viewer). Without it, a restart closes every open room. Chat and who is connected are never saved. Redis also keeps the upload index (last read, rooms, closed marks), which is rebuilt from disk on every start, and the catalog responses (so a restart does not start the catalog source from cold).

Redis is never the source of truth and never blocks the server: each call has a 300 ms ceiling and falls back silently (one log warning per minute). It holds no secrets worth persisting, so run it **in RAM only and bound to localhost**:

This uses Docker; without it, `sudo apt install redis-server` works too, as long as it listens only on `127.0.0.1` and you disable persistence (`save ""`, `appendonly no`).

```bash
docker run -d --name lunio-redis --restart unless-stopped -p 127.0.0.1:6379:6379 redis:8-alpine \
  redis-server --save "" --appendonly no --maxmemory 128mb --maxmemory-policy volatile-ttl
```

Then add `REDIS_URL=redis://127.0.0.1:6379` to `/opt/lunio/app/.env` and `sudo systemctl restart lunio`. **Status** shows "Redis: connected" when it works. Never expose the port publicly.
