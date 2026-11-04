# Arquitetura e API

[English](architecture.md) · **Português** · ← [Voltar ao README](../README.pt-BR.md)

## Como funciona

```
Navegador (React + Vidstack)
   │  HTTP  ── /api/proxy, /api/tracks, /api/subtitle, /api/upload …
   │  WebSocket ── /api/ws (salas, sincronia, chat)
   ▼
Backend: router Express (src/server/app.ts), servido por src/server/main.ts em produção
ou plugado no servidor de dev/preview do Vite (vite.config.ts)
   ├─ proxy de mídia: repasse com HTTP Range, remux fMP4 via FFmpeg para áudio alternativo
   ├─ inspeção de faixas e extração de legendas/fontes (FFmpeg + mkv_extractor)
   ├─ envios (.uploads/) e resolvedor do Google Drive
   └─ servidor de salas (src/server/roomServer.ts)
```

### Rotas da API

| Rota | Descrição |
|---|---|
| `GET /api/proxy?url=` | Faz o stream de um vídeo remoto (com Range). Com `audio=`, faz remux para fMP4 com essa faixa de áudio |
| `POST /api/hls/start`, `GET /api/hls/<id>/<áudio>/index.m3u8`, `GET /api/hls/<id>/<áudio>/<n>.ts` | HLS compartilhado de uma faixa de áudio alternativa: playlist e segmentos de ~6 s gerados sob demanda e guardados em cache (só MKV com Cues + vídeo H.264; senão o `start` responde 501 e o player usa o remux) |
| `GET /api/tracks?url=` | Faixas de áudio, legenda, capítulos e fontes de um arquivo |
| `GET /api/subtitle?url=&track=` | Extrai uma legenda embutida (cache em `.cache/subtitles`) |
| `GET /api/font?url=&track=` | Extrai uma fonte embutida. As fontes ficam guardadas uma vez por conteúdo (hardlinks em `.cache/fonts/_shared`), então episódios do mesmo grupo as compartilham |
| `GET /api/fontmap?url=` | Os nomes pelos quais cada fonte embutida pode ser pedida (família, nome completo, PostScript). O player carrega só as fontes que a legenda usa, em vez das ~24 anexadas ao MKV |
| `GET /api/resolve?url=` | Resolve redirecionamentos do Torrentio/debrid até a URL final da CDN |
| `GET /api/upstream?url=` | Se o provedor do vídeo (ou o CDN dele) limitou o servidor agora (429). O player pergunta quando a reprodução falha, para dizer "o provedor limitou os pedidos". Não faz pedido nenhum ao provedor |
| `GET /api/catalog/manifest`, `/row`, `/search`, `/meta` | O catálogo (fileiras, busca, detalhes) da fonte configurada (`CATALOG_URL`, padrão Cinemeta), com cache no servidor; se a fonte cair, serve a última resposta guardada (`stale: true`). A URL da fonte nunca chega ao navegador |
| `GET /api/room?id=` | Se uma sala existe ou foi encerrada |
| `POST /api/upload/start`, `PUT /api/upload/<id>?offset=`, `POST /api/upload/<id>/finish`, `DELETE /api/upload/<id>` | Envio em pedaços e retomável (até 50 GB) para `.uploads/`. Os pedaços são de 64 MB por padrão para cada requisição passar por proxies que limitam o corpo (o plano grátis da Cloudflare aceita 100 MB) |
| `POST /api/uploads/claim`, `POST /api/uploads/status` | Reabre um envio recente numa sala nova e confere se ele ainda está no servidor |
| `GET /api/uploads/<id>/<nome>` | Serve um arquivo enviado com suporte a Range |
| `GET /api/drive?url=` | Resolve um link de compartilhamento do Google Drive para uma URL reproduzível |
| `POST /api/session` | Token de sessão de quem assiste sozinho (quem está em sala recebe o seu pelo WebSocket). As rotas de mídia exigem o token |
| `POST /api/screen/token` | Endereço do relay com o token certo para quem pede: de publicar para o Host que está transmitindo, só de assistir para os demais (e só quando a transmissão está ao vivo). Só membros da sala, com limite de pedidos, nunca em cache |
| `GET /api/status` | Se o FFmpeg e o Python foram encontrados (só versões), e os números da transmissão de tela (ligada, transmissões ao vivo, bytes enviados pelos Hosts, saída estimada do relay) |
| `POST /api/token` | Troca do código OAuth2 do Discord |
| `WS /api/ws` | Salas: participantes, sincronia de reprodução, chat, moderação e as mensagens `screen:*` da transmissão de tela (a chave de criptografia viaja por aqui, só para quem está na sala) |

Salas vazias são encerradas cerca de 30 segundos depois que a última pessoa sai (`EMPTY_ROOM_TTL_MS` em `src/server/roomServer.ts`). Uma sala restaurada do Redis a que ninguém volta encerra depois dos 60 s de prioridade do Host mais esses 30 segundos.

## Estrutura do projeto

```
src/
  App.tsx                   Telas: Home (catálogo, sala, status) e player
  components/
    home/                   Menu da sala, passos de cada fonte (stream, envio, YouTube, Drive, entrar), última sala e aba Status
    catalog/                Fileiras do catálogo, busca, Explorar, página do título, addons e lista de streams
    player/                 Hooks do player (sincronia da sala, áudio alternativo, legendas, controles, atalhos…),
                            overlays e o palco da transmissão de tela
    VideoPlayer.tsx         Composição do player (Vidstack)
    PlayerControls.tsx      Barra de controles e menus
    WatchPartyPanel.tsx     Chat e participantes
    ui.tsx                  Primitivas de interface (design system)
  lib/                      Cliente da sala (sync.ts), legendas, utilitários de mídia, catálogo, addons, continuar assistindo
    screen/                 Motor da transmissão de tela: captura, codificação, criptografia, transporte MoQ, reprodução
  server/                   Backend, independente do Vite
    app.ts / main.ts        Roteador da API / entrada de produção
    routes/                 Um arquivo por endpoint
    media/                  Proxy, faixas, legendas, fontes, HLS, remux, envios, cache
    roomServer.ts           Salas: sincronia, chat, fila, Host e estado da transmissão de tela
    roomStore.ts            Salas guardadas no Redis
  types/                    Tipos compartilhados entre cliente e servidor
mkv_extractor/              Extrator Python de legendas e keyframes dentro de MKV remoto (HTTP Range)
e2e/                        Testes de ponta a ponta com Playwright (servidor de produção + MKV local de teste)
tests/                      Testes Python (mkv_extractor)
docs/                       Documentação técnica
public/                     Estáticos: JASSUB (libass), fontes de reserva, vídeo de exemplo Sintel
assets/                     Imagens do README (readme/) e arte do Discord (discord/)
DESIGN.md                   Notas do design system
```
