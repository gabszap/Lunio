# Extração remota de legendas

O pacote extrai `S_TEXT/ASS`, `S_TEXT/SSA` e `S_TEXT/UTF8` de MKV remoto,
reutilizando o índice Cues e leituras HTTP Range em lote. Não executa FFmpeg.
Continuam necessários Cues da faixa com `CueRelativePosition` para acesso direto.

```console
python -m mkv_extractor "URL_DO_MKV"
python -m mkv_extractor "URL_DO_MKV" --stream-index 2 -o legenda --json
python -m mkv_extractor "URL_DO_MKV" --language por --prefer brazilian -o legenda.srt
```

`--stream-index` é o índice global do stream (base zero); `--track` conserva
a seleção por TrackNumber e os fallbacks existentes. A seleção automática
avalia idioma, preferência, faixa forçada e padrão entre os três codecs.

ASS e SSA geram `.ass`, preservando o cabeçalho CodecPrivate e a ordem ASS.
UTF8 gera `.srt` e dispensa CodecPrivate. Sem extensão em `-o`, o pacote
acrescenta a extensão do formato detectado. Um caminho com extensão explícita
compatível é preservado; uma extensão incompatível causa erro sem sobrescrever
o arquivo. Sem `-o`, a CLI salva na pasta atual com o nome do MKV e a extensão
do codec. O nome vem de Content-Disposition, da URL final ou da URL original;
a leitura da URL segue as fontes usadas pelo Lunio (segmentos de vídeo e
`torrent_name`, `filename`, `name`). O nome completo do release é preservado.
Se não houver nome identificável, usa `legenda`. Arquivos automáticos existentes
são preservados com sufixos ` (1)`, ` (2)` etc. `--json` também salva o arquivo
por padrão; use `--stdout` para retornar à saída no terminal, sem salvar.
`--all` e `--both` geram extensões individuais conforme o codec de cada faixa.

A API Python mantém a extração em memória quando `output_path` é omitido.
Para ativar o nome automático pela API, use `auto_output=True`.

Para ASS/SSA e SRT, o início é calculado pelo Timestamp do Cluster mais o timecode
assinado do Block, aplicando TimecodeScale. A duração vem de BlockDuration,
depois de CueDuration. Na ausência de ambos, o fim é inferido do próximo
início distinto na mesma faixa; no último evento, usa-se 3,5 segundos.
Esses fins inferidos são estimativas, pois o arquivo não fornece a duração.
Os eventos são ordenados pelo início, numerados sequencialmente e escritos
em UTF-8 com timestamps `HH:MM:SS,mmm` no SRT. ASS mantém ReadOrder e estilos.

## Integridade, HTTP e configuração

HTTP Range exige `206`, Content-Range e tamanho exatos. Respostas `200` são
recusadas antes de ler o corpo; multipart incompleto/duplicado é erro. Sessões
isolam conexões, fixam tamanho/ETag quando disponível e verificam TLS por padrão.
Use `SSL_CERT_FILE` para uma CA local ou forneça um SSLContext a `RangeSession`.

O JSON informa `coverage`, `complete_verified`, `strategy`, `duration_sources`,
`inferred_events` e `http_metrics`. Sem estatísticas de faixa confiáveis, o
resultado é `unverified`/`best_effort`, sem afirmar cobertura comprovada.
`--strict` exige estatísticas compatíveis com TrackUID, WritingApp, duração e
DateUTC quando disponível; essa conferência é um sinal conservador, não uma
prova criptográfica de integridade. Cues comprovadamente incompletos são erro.

```console
python -m mkv_extractor "URL_DO_MKV" --strict --json
python -m mkv_extractor "URL_DO_MKV" --fallback-duration-ms 2000
python -m mkv_extractor "URL_DO_MKV" --no-duration-estimates
python -m mkv_extractor "URL_DO_MKV" --public-only
python -m mkv_extractor "URL_DO_MKV" --coalesce-gap-bytes 512 --coalesce-extra-bytes 65536
```

`--public-only` bloqueia IPs internos inclusive após redirects e valida o IP
conectado sem uma segunda resolução DNS. `--allow-origin http://host:porta`
autoriza uma origem interna exata; a CLI local não bloqueia loopback por padrão.
Coalescência é opt-in e tem orçamento total de bytes extras. O custo estimado
considera lotes e bytes; `--measure-multipart-cost` também mede RTT para decidir
quando multipart pode ser mais caro que a leitura sequencial externa.

A descoberta de Cues prioriza SeekHead; sem ele, pula filhos top-level por seus
tamanhos, com limite de 512 cabeçalhos. Não procura mais IDs dentro de payloads
do vídeo. Cues, blocos e samples descomprimidos têm limites; recursos não
suportados geram `[FallbackReason]` com motivo estável e sem executar FFmpeg.
As posições dos blocos são comprovadas por saltos entre filhos reais dos Clusters,
com orçamento de 4096 leituras extras (`--max-boundary-headers`). Blocos aparentes
dentro de um payload não são aceitos como filhos. Se o orçamento acabar, a
extração para explicitamente; validar fontes densas pode adicionar RTT.
Há suporte a lacing com tempo por frame, zlib, bzlib e header stripping;
criptografia/LZO e casos sem tempo por frame são recusados explicitamente.

Arquivos são publicados atomicamente; nomes automáticos continuam protegidos
contra sobrescrita concorrente. No Lunio, o servidor exige cobertura verificada,
extrai no formato nativo e converte SRT **local** para o cache ASS do player.
A biblioteca Python nunca inicia um download remoto por FFmpeg.

Referências de formato: [Matroska/RFC 9559](https://www.rfc-editor.org/rfc/rfc9559.html)
e [mapeamento de legendas](https://www.matroska.org/technical/subtitles.html).

```console
python -m pytest tests
python tests/benchmark_mkv_extractor.py
```
