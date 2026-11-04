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

## Screen sharing (optional)

See [Screen sharing](screen-sharing.md) for the relay and its variables.

## Optional: Redis

Lunio runs fine without Redis. With it, **rooms survive a restart or deploy**: the host, bans, queue, current video and position are saved and restored before the server accepts connections, and the previous host gets 60 s to come back (anyone reconnecting sooner joins as a viewer). Without it, a restart closes every open room. Chat and who is connected are never saved. Redis also keeps the upload index (last read, rooms, closed marks), which is rebuilt from disk on every start, and the catalog responses (so a restart does not start the catalog source from cold).

Redis is never the source of truth and never blocks the server: each call has a 300 ms ceiling and falls back silently (one log warning per minute). It holds no secrets worth persisting, so run it **in RAM only and bound to localhost**:

This uses Docker; without it, `sudo apt install redis-server` works too, as long as it listens only on `127.0.0.1` and you disable persistence (`save ""`, `appendonly no`).

```bash
docker run -d --name lunio-redis --restart unless-stopped -p 127.0.0.1:6379:6379 redis:8-alpine \
  redis-server --save "" --appendonly no --maxmemory 128mb --maxmemory-policy volatile-ttl
```

Then add `REDIS_URL=redis://127.0.0.1:6379` to `/opt/lunio/app/.env` and `sudo systemctl restart lunio`. **Status** shows "Redis: connected" when it works. Never expose the port publicly.
