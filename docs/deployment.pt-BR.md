# Deploy em um servidor

[English](deployment.md) · **Português** · ← [Voltar ao README](../README.pt-BR.md)

Uma VPS pequena basta. O Lunio roda como um único processo Node (`npm run serve`); o Caddy fica na frente cuidando de HTTPS e WebSocket, e o systemd mantém tudo de pé. Troque `lunio.exemplo.com` pelo seu domínio (o DNS precisa apontar para o servidor) e libere as portas 80 e 443.

**1. Instalar Node 22, FFmpeg, Python e Caddy**

```bash
sudo apt update && sudo apt install -y ffmpeg python3 git curl debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
# Caddy: https://caddyserver.com/docs/install#debian-ubuntu-raspbian
sudo apt install -y caddy
```

O `python3` do Ubuntu é o 3.12 (o Lunio pede 3.10+) e é detectado sozinho; não existe o comando `python` e não precisa.

**2. Baixar o código e configurar**

```bash
sudo useradd --system --create-home --home-dir /opt/lunio --shell /usr/sbin/nologin lunio
sudo -u lunio git clone https://github.com/gabszap/Lunio.git /opt/lunio/app
cd /opt/lunio/app
sudo -u lunio npm ci
sudo -u lunio npm run build
sudo -u lunio cp .env.example .env
sudo -u lunio nano .env
```

No `.env`, defina pelo menos:

```ini
SESSION_SECRET=<saída de: openssl rand -hex 32>
TRUST_PROXY=1                              # o Caddy está na frente: usa o IP real do cliente
ALLOWED_ORIGINS=                           # só se o site também for servido por outras origens
VITE_DISCORD_CLIENT_ID=...                 # só para a Atividade do Discord
DISCORD_CLIENT_SECRET=...
```

Deixe `ALLOW_PRIVATE_URLS` vazio. Ele existe só para testes locais e desliga a proteção que impede o servidor de alcançar a sua rede interna.

**3. Build e serviço systemd** — `/etc/systemd/system/lunio.service`

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
journalctl -u lunio -f      # ao iniciar, mostra qual FFmpeg e qual Python foram encontrados
```

O `WorkingDirectory` importa: `.uploads/`, `.cache/`, `dist/` e `.env` ficam nele. O `npm run serve` não faz build, então rode `npm run build` uma vez a cada `git pull` (os restarts ficam instantâneos). `PORT` e `HOST` no `.env` mudam onde ele escuta (padrão `0.0.0.0:3000`).

**4. Caddy (HTTPS + WebSocket)** — `/etc/caddy/Caddyfile`

```caddyfile
lunio.exemplo.com {
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
}
```

```bash
sudo systemctl reload caddy
```

O Caddy obtém o certificado sozinho e faz proxy de WebSocket sem configuração extra, então o navegador conecta em `wss://lunio.exemplo.com/api/ws`. O `flush_interval -1` entrega o stream de áudio alternativo aos espectadores conforme o FFmpeg produz, sem buffer.

**5. Conferir**

Abra `https://lunio.exemplo.com` e vá em **Status**: Servidor, FFmpeg e Python devem estar verdes. Depois crie uma sala, entre por um segundo navegador e troque a faixa de áudio.

**Atualizar:** `cd /opt/lunio/app && sudo -u lunio git pull && sudo -u lunio npm ci && sudo -u lunio npm run build && sudo systemctl restart lunio`. Sem `REDIS_URL`, reiniciar encerra as salas abertas; com ele, elas voltam.

## Transmissão de tela (opcional)

Veja [Transmissão de tela](screen-sharing.pt-BR.md) para o relay e as variáveis.

## Opcional: Redis

O Lunio funciona sem Redis. Com ele, **as salas sobrevivem a um restart ou deploy**: Host, bans, fila, vídeo atual e posição são salvos e restaurados antes de o servidor aceitar conexões, e o Host anterior tem 60 s para voltar (quem reconecta antes entra como espectador). Sem ele, um restart encerra todas as salas abertas. O chat e quem está conectado nunca são salvos. O Redis também guarda o índice dos envios (último uso, salas, marcas de sala fechada), reconstruído do disco a cada subida, e as respostas do catálogo (para um restart não esfriar a fonte do catálogo).

O Redis nunca é a fonte da verdade e nunca trava o servidor: cada chamada tem teto de 300 ms e cai para o comportamento sem Redis em silêncio (um aviso no log por minuto). Rode-o **só em RAM e preso ao localhost**. Este exemplo usa Docker; sem ele, `sudo apt install redis-server` também serve, desde que escute só em `127.0.0.1` e com a persistência desligada (`save ""`, `appendonly no`):

```bash
docker run -d --name lunio-redis --restart unless-stopped -p 127.0.0.1:6379:6379 redis:8-alpine \
  redis-server --save "" --appendonly no --maxmemory 128mb --maxmemory-policy volatile-ttl
```

Depois coloque `REDIS_URL=redis://127.0.0.1:6379` no `/opt/lunio/app/.env` e rode `sudo systemctl restart lunio`. A aba **Status** mostra "Redis: conectado" quando funciona. Nunca exponha a porta publicamente.
