<p align="center">
  <img src="docs/banner-pt.webp" alt="Lunio — assista junto, no mesmo segundo" width="100%">
</p>

# Lunio

[English](README.md) · **Português**

O Lunio é um player de vídeo web feito para assistir junto. Cole um link de stream, envie um arquivo ou abra um vídeo do YouTube/Google Drive, crie uma sala e todo mundo nela assiste sincronizado — com chat, legendas ASS renderizadas como num player de desktop, faixas de áudio alternativas e capítulos. Também roda como Atividade do Discord (em desenvolvimento).

## Recursos

- **Salas (Watch Party)** — crie uma sala a partir de qualquer fonte e compartilhe um código de 8 caracteres ou o link. O Host controla play, pause, seek e velocidade; os demais acompanham com correção contínua de atraso. Chat, lista de participantes, passar o Host, expulsar e banir.
- **Fontes de vídeo**
  - Links diretos de stream: Stremio, TorBox, e outros debrids, `.mkv`/`.mp4`/`.webm`/HLS, passando pelo proxy do servidor local (HTTP Range, contorna CORS).
  - Envio de arquivo (até 50 GB) — a sala já existe enquanto o arquivo sobe. Assistindo sozinho, o arquivo toca direto do computador, sem enviar.
  - Vídeos e lives do YouTube.
  - Arquivos do Google Drive compartilhados como "Qualquer pessoa com o link".
- **Suporte a MKV** — faixas de áudio e legenda detectadas com FFmpeg. Trocar para outra faixa de áudio faz remux do stream para fMP4 na hora.
- **Legendas** — ASS/SSA embutidas renderizadas com libass (JASSUB, WebAssembly), incluindo fontes embutidas; `.ass`, `.srt` (convertida para WebVTT) e `.vtt` externas por arquivo ou URL; ajuste de sincronia e tamanho da fonte.
- **Player** — timeline dividida por capítulos, "Pular abertura/encerramento" nos capítulos detectados, velocidade, atraso do áudio, volume boost, modos de ajuste de tela, picture-in-picture, continuar de onde parou, atalhos de teclado.
- **Catálogo** — navegue e busque filmes e séries (metadados do addon público Cinemeta, do Stremio), com temporadas, episódios e uma lista pessoal. O catálogo só fornece metadados: para assistir, você ainda escolhe uma fonte de vídeo.
- **Página de status** — verifica o servidor local, o catálogo e a sua sala atual.

## Capturas de tela

| Home | Player |
|---|---|
| ![Home: crie uma sala a partir de um arquivo, YouTube, Google Drive ou link de stream](docs/home.webp) | ![Player com timeline de capítulos e controles](docs/player.webp) |

<sub>Vídeo nas capturas: *Sintel* © Blender Foundation, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).</sub>

## Requisitos

| Ferramenta | Usada para | Observações |
|---|---|---|
| Node.js 20+ | Tudo | |
| FFmpeg | Detecção de faixas, troca de faixa de áudio, extração de legendas (fallback) | Procurado em `C:\Program Files\mpv\ffmpeg.exe`, depois `C:\ffmpeg\ffmpeg.exe`, depois `ffmpeg` no `PATH` |
| Python 3.10+ | Extração rápida de legendas embutidas (`mkv_extractor`) | Só biblioteca padrão. Sem ele, as legendas usam o FFmpeg (mais lento). Defina `PYTHON_PATH` se `python` não estiver no `PATH` |

## Como rodar

```bash
npm install
npm run dev      # desenvolvimento (hot reload)
npm start        # produção: gera o build e serve a versão otimizada
```

Abra <http://localhost:3000>. O servidor de desenvolvimento também escuta na rede local, então amigos na mesma rede podem entrar usando o IP da sua máquina.

### Variáveis de ambiente

Copie `.env.example` para `.env` (só é necessário para a Atividade do Discord):

| Variável | Descrição |
|---|---|
| `VITE_DISCORD_CLIENT_ID` | ID da aplicação do Discord usada pela Atividade |
| `DISCORD_CLIENT_SECRET` | Segredo da aplicação do Discord, usado pelo `/api/token` na troca OAuth2 |
| `PYTHON_PATH` | *(opcional)* Interpretador Python do extrator de legendas |
| `DISABLE_HMR` | *(opcional)* `true` desliga o hot reload do Vite |

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Desenvolvimento: app + API + WebSocket na porta 3000, com hot reload |
| `npm start` | Produção: gera o `dist/` e serve com a API e o WebSocket na porta 3000 |
| `npm run build` | Gera o frontend em `dist/` |
| `npm run preview` | Serve um `dist/` já gerado com a API e o WebSocket (sem refazer o build) |
| `npm run lint` | Checagem de tipos (`tsc --noEmit`) |
| `python -m pytest tests` | Roda os testes do `mkv_extractor` |

> O backend (proxy de mídia, envios, salas) é um plugin do Vite registrado tanto no servidor de desenvolvimento quanto no de preview, então `npm start` roda o app completo a partir do build otimizado: minificado, sem hot reload e sem expor o código-fonte. Use `npm run dev` só enquanto estiver desenvolvendo.

## Como funciona

```
Navegador (React + Vidstack)
   │  HTTP  ── /api/proxy, /api/tracks, /api/subtitle, /api/upload …
   │  WebSocket ── /api/ws (salas, sincronia, chat)
   ▼
Servidor do Vite, dev ou preview (vite.config.ts)
   ├─ proxy de mídia: repasse com HTTP Range, remux fMP4 via FFmpeg para áudio alternativo
   ├─ inspeção de faixas e extração de legendas/fontes (FFmpeg + mkv_extractor)
   ├─ envios (.uploads/) e resolvedor do Google Drive
   └─ servidor de salas (src/server/roomServer.ts)
```

### Rotas da API

| Rota | Descrição |
|---|---|
| `GET /api/proxy?url=` | Faz o stream de um vídeo remoto (com Range). Com `audio=`, faz remux para fMP4 com essa faixa de áudio |
| `GET /api/tracks?url=` | Faixas de áudio, legenda, capítulos e fontes de um arquivo |
| `GET /api/subtitle?url=&track=` | Extrai uma legenda embutida (cache em `.cache/subtitles`) |
| `GET /api/font?url=&track=` | Extrai uma fonte embutida |
| `GET /api/resolve?url=` | Resolve redirecionamentos do Torrentio/debrid até a URL final da CDN |
| `GET /api/room?id=` | Se uma sala existe ou foi encerrada |
| `POST /api/upload?name=` | Envia um arquivo (corpo cru, até 50 GB) para `.uploads/` |
| `GET /api/uploads/<id>/<nome>` | Serve um arquivo enviado com suporte a Range |
| `GET /api/drive?url=` | Resolve um link de compartilhamento do Google Drive para uma URL reproduzível |
| `POST /api/token` | Troca do código OAuth2 do Discord |
| `WS /api/ws` | Salas: participantes, sincronia de reprodução, chat, moderação |

Salas vazias são encerradas cerca de 30 segundos depois que a última pessoa sai (`EMPTY_ROOM_TTL_MS` em `src/server/roomServer.ts`).

## Estrutura do projeto

```
src/
  App.tsx                 Telas: Home (catálogo, sala, status) e player
  components/
    home/                 Menu da sala e passos de cada fonte (stream, envio, YouTube, Drive, entrar)
    catalog/              Catálogo, busca e detalhes do título
    VideoPlayer.tsx       Núcleo do player (Vidstack), sincronia, overlays
    PlayerControls.tsx    Barra de controles e menus
    WatchPartyPanel.tsx   Chat e participantes
    ui.tsx                Componentes visuais compartilhados (design system)
  lib/                    Cliente de sincronia, legendas, utilitários de mídia, catálogo, Discord
  server/                 Servidor de salas e rotas de envio/Drive
mkv_extractor/            Extrator em Python de legendas de MKV remotos (HTTP Range)
public/                   Arquivos estáticos: JASSUB (libass), fontes de fallback, exemplo Sintel
docs/                     Imagens do README
DESIGN.md                 Notas do design system
```

## Atalhos de teclado

| Tecla | Ação |
|---|---|
| `Espaço` / `K` | Play / pause |
| `J` / `←` · `L` / `→` | Voltar / avançar 10 s |
| `N` / `O` | Pular abertura (+90 s, ou até o fim da abertura/encerramento detectado) |
| `↑` / `↓` | Volume ±5% |
| `M` | Silenciar |
| `C` | Ligar/desligar legendas |
| `G` / `H` | Sincronia da legenda ±50 ms (`Shift` para ±250 ms) |
| `[` / `]` | Atraso do áudio ±50 ms |
| `Z` | Ajuste de tela |
| `F` | Tela cheia |
| `W` | Painel da Watch Party |

## Limitações conhecidas

- Links de torrent e compartilhamento de tela aparecem no menu como "Em breve"; precisam de um motor de torrent e de WebRTC no servidor.
- Arquivos enviados ficam em `.uploads/` até você apagá-los.
- O ban vale para a identidade da aba do navegador; uma aba nova ou outro navegador recebe uma identidade nova.
