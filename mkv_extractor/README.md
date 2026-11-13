# Extração remota de legendas

O pacote extrai `S_TEXT/ASS`, `S_TEXT/SSA` e `S_TEXT/UTF8` de MKV remoto,
reutilizando o índice Cues e leituras HTTP Range em lote. Não executa FFmpeg.
Continuam necessários Cues da faixa com `CueRelativePosition` para acesso direto.

```console
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
o arquivo. Sem `-o`, o conteúdo continua sendo impresso na saída padrão.
`--all` e `--both` geram extensões individuais conforme o codec de cada faixa.

Para SRT, o início é calculado pelo Timestamp do Cluster mais o timecode
assinado do Block, aplicando TimecodeScale. A duração vem de BlockDuration,
depois de CueDuration. Na ausência de ambos, o fim é inferido do próximo
início distinto na mesma faixa; no último evento, usa-se 3,5 segundos.
Esses fins inferidos são estimativas, pois o arquivo não fornece a duração.
Os eventos são ordenados pelo início, numerados sequencialmente e escritos
em UTF-8 com timestamps `HH:MM:SS,mmm`.

```console
python -m pytest tests
```
