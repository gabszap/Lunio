# Transmissão de tela

[English](screen-sharing.md) · **Português** · ← [Voltar ao README](../README.pt-BR.md)

Desligada por padrão. Usa **MoQ sobre WebTransport** por um relay: o navegador do Host captura a tela (`getDisplayMedia`), codifica com WebCodecs (vídeo H.264, áudio Opus) e publica no relay; quem assiste se inscreve, decodifica e desenha, com o áudio como relógio. O servidor só coordena (quem está transmitindo, a qualidade, as chaves) e nunca toca no vídeo.

Para ligar é preciso um relay. O padrão é o [relay MoQ gerenciado da Cloudflare](https://developers.cloudflare.com/) (beta): crie um relay, ponha a URL e os dois tokens padrão dele no `.env` e ligue a flag:

```bash
SCREEN_SHARE_ENABLED=1
MOQ_RELAY_URL=https://<seu relay>
MOQ_TOKEN_PUBLISH=…
MOQ_TOKEN_SUBSCRIBE=…
```

- **Quem faz o quê.** Só o Host da sala inicia a transmissão (Chromium no computador; a página pede a tela e, se o navegador oferecer, o áudio do sistema). A qualidade escolhida pelo Host vale para aquela transmissão: não há troca automática. O token de publicar do relay só é entregue ao Host que está transmitindo.
- **Privacidade.** Todo quadro é criptografado (AES-GCM) com uma chave que o navegador do Host gera, e o servidor entrega essa chave só a quem está na sala naquele momento, pelo WebSocket da sala. Um token do relay não pode ser limitado a uma transmissão e revogá-lo não derruba uma conexão já aberta, então a criptografia é o que deixa os de fora de fora. Quando alguém é expulso, banido ou sai, o Host gira a chave e quem fica recebe a nova; quem saiu continua recebendo bytes que não consegue mais decodificar. As chaves nunca são guardadas, registradas em log nem postas no estado da sala.
- **Navegadores.** Host: Chrome, Edge ou Brave no computador (versão recente: as antigas ignoram a opção que deixa o som do próprio vídeo da sala fora do áudio do sistema compartilhado, e quem assiste pode ouvir o vídeo do Host em dobro; compartilhar uma janela em vez da tela inteira evita isso). Quem assiste: navegadores Chromium e Firefox. Safari e iOS não são suportados, e a transmissão fica desligada dentro da Activity do Discord.
- **Custo.** O relay está em beta, sem preço nem medidor. O servidor conta o que os Hosts enviam e estima a saída (bytes × espectadores): a aba **Status** mostra, e os números do dia ficam no Redis quando ele está ligado. Para ter ideia: 1080p60 é até 10 Mbps, cerca de 4,5 GB por hora *por espectador*. `SCREEN_SHARE_MAX_LIVE` limita as transmissões simultâneas. Se o relay gerenciado virar problema, o transporte fica atrás de uma interface, então um `moq-relay` próprio (ou outro provedor) pode entrar no lugar sem mexer no resto.
- **Limites.** A transmissão acaba com o Host (troca de Host, saída, fechar a página ou reiniciar o servidor). Ela fica só na memória e nunca vai ao Redis. O 60 fps depende da máquina do Host: alguns computadores só capturam ~30 fps mesmo pedindo 60.
