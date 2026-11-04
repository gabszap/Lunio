# Configuração

[English](configuration.md) · **Português** · ← [Voltar ao README](../README.pt-BR.md)

Copie `.env.example` para `.env`. Localmente nada é obrigatório (só a Atividade do Discord usa as duas primeiras); em servidor, defina pelo menos `SESSION_SECRET` e `TRUST_PROXY`. Variáveis já definidas no ambiente (systemd, Docker) têm prioridade sobre o arquivo.

| Variável | Descrição |
|---|---|
| `VITE_DISCORD_CLIENT_ID` | ID da aplicação do Discord usada pela Atividade |
| `DISCORD_CLIENT_SECRET` | Segredo da aplicação do Discord, usado pelo `/api/token` na troca OAuth2 |
| `SESSION_SECRET` | Assina os tokens de sessão. Sem ele, um novo é gerado a cada início |
| `ALLOWED_ORIGINS` | Origens extras (separadas por vírgula) autorizadas a chamar a API e abrir o WebSocket. Padrão: a própria origem + a Atividade do Discord |
| `TRUST_PROXY` | `1` atrás de Caddy/nginx: o IP do cliente (usado nos limites) vem do `X-Forwarded-For` |
| `FFMPEG_PATH` | *(opcional)* Executável do FFmpeg. Senão, `ffmpeg` no `PATH` e depois caminhos conhecidos do Windows |
| `PYTHON_PATH` | *(opcional)* Python 3.10+ do extrator de legendas. Senão, `python3`, `python`, `py -3` |
| `MAX_UPLOAD_DISK_GB` / `MAX_UPLOAD_FILE_GB` | Cota de disco dos envios (padrão 20) e tamanho máximo de um envio (padrão 50) |
| `UPLOAD_TTL_HOURS` | Horas que um envio fica depois que a sala fecha (padrão 24) |
| `UPLOAD_IDLE_HOURS` | Horas que um envio de sala aberta pode ficar sem ser lido antes de ser removido (padrão 24) |
| `MIN_FREE_DISK_GB` | Espaço livre a manter no disco da máquina; abaixo disso os envios são recusados (padrão 5) |
| `REDIS_URL` | *(opcional)* Um Redis local, ex.: `redis://127.0.0.1:6379`. Com ele as salas sobrevivem a um restart e o índice dos envios fica nele. Veja [Redis](deployment.pt-BR.md#opcional-redis) |
| `ROOM_STATE_TTL_HOURS` / `ROOM_HOST_GRACE_SECONDS` | Com Redis: por quanto tempo o estado salvo de uma sala vale (padrão 24) e quanto tempo o Host anterior tem para voltar depois de um restart antes de outra pessoa assumir (padrão 60) |
| `CATALOG_URL` | *(opcional)* Addon do Stremio que alimenta o catálogo: a URL de instalação ou a base de um [AIOMetadata](https://github.com/cedya77/aiometadata) (`https://…/stremio/<uuid>/<config>/manifest.json`, `stremio://…` também vale), ou qualquer addon com catálogos. Vazio = Cinemeta. Deixe só no `.env` do servidor: ela leva a sua configuração e chaves |
| `JIKAN_URL` | *(opcional)* API da nota do MyAnimeList mostrada na página dos animes: uma instância compatível com o Jikan (`GET <base>/anime/<id>` com `data.score`), base com o prefixo de versão. A API oficial do Jikan foi desligada, então use uma instância pública de terceiros ou a sua. Vazia = a instância pública padrão (jikan-edge). A nota é pedida à parte da página (3 tentativas no servidor e depois o navegador tenta de novo), fica em cache por 24 h; sem resposta, a página só omite a nota. Animes que chegam pelo id do IMDb são ligados ao id do MyAnimeList pela busca de anime da fonte |
| `MAX_CACHE_GB` | Limite de `.cache/` (padrão 10, inclui os segmentos HLS); apaga primeiro o menos usado |
| `MAX_FFMPEG_PROCS` | Processos FFmpeg/Python ao mesmo tempo (padrão 8) |
| `FFMPEG_THROUGHPUT_MBPS` | Palpite inicial (padrão 40) de quão rápido o FFmpeg lê um CDN, usado para escolher entre o extrator de legendas e ler o arquivo todo. Depois de leituras reais, o servidor usa a média medida por host do CDN |
| `SCREEN_SHARE_ENABLED` | *(opcional)* `1` liga a transmissão de tela. Precisa também das três variáveis abaixo; sem elas continua desligada. Veja [Transmissão de tela](screen-sharing.pt-BR.md#transmissão-de-tela) |
| `MOQ_RELAY_URL` / `MOQ_TOKEN_PUBLISH` / `MOQ_TOKEN_SUBSCRIBE` | O relay MoQ (`https://…`, sem o token na URL) e seus dois tokens: um que publica (só entregue ao Host que está transmitindo) e outro que só assiste. **Segredos**: deixe só no `.env` do servidor |
| `SCREEN_SHARE_MAX_LIVE` | Quantas salas podem transmitir ao mesmo tempo (padrão 10). O relay está em beta e ainda não mede nem cobra, então o teto é nosso |
| `ALLOW_PRIVATE_URLS` | Só para testes locais: deixa o proxy alcançar endereços de rede privada. Mantenha vazio em produção |
| `DISABLE_HMR` | *(opcional)* `true` desliga o hot reload do Vite |
