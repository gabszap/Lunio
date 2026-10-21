// Servidor de fixture para os testes E2E: gera um MKV curto (2 áudios) e serve com HTTP Range.
// Sem TorBox: o Lunio busca o vídeo daqui pelo proxy (ALLOW_PRIVATE_URLS=1 só no ambiente de teste).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.fixtures');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'teste.mkv');
// v2: com duas fontes anexadas (o nome novo evita reaproveitar o arquivo antigo, sem anexos, de quem já rodou os testes)
const subsFile = path.join(dir, 'legendas.mkv');
const subsStamp = path.join(dir, 'legendas.v2');

if (!fs.existsSync(file)) {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const r = spawnSync(
    ffmpeg,
    [
      '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=duration=120:size=320x180:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=120',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=120',
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac',
      '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=por',
      file,
    ],
    { encoding: 'utf-8' }
  );
  if (r.status !== 0) {
    console.error('Não consegui gerar o vídeo de teste (FFmpeg com libx264 é necessário):', r.stderr || r.error);
    process.exit(1);
  }
}

// Segundo vídeo (20 s): áudio japonês + português e duas legendas ASS (0:3 = en, 0:4 = pt).
// Legenda obrigatória por causa do áudio japonês: serve para testar o gating e o "Tentar a próxima".
if (!fs.existsSync(subsFile) || !fs.existsSync(subsStamp)) {
  const ass = (text, font = 'Arial') => `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font},48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:15.00,Default,,0,0,0,,${text}
`;
  // en.ass pede uma fonte que não está anexada; pt.ass pede a Trebuchet MS, que está. O player deve baixar só essa.
  fs.writeFileSync(path.join(dir, 'en.ass'), ass('English subtitle for the Lunio test'));
  fs.writeFileSync(path.join(dir, 'pt.ass'), ass('Legenda em portugues para o teste do Lunio', 'Trebuchet MS'));
  // Duas fontes: a Trebuchet de verdade e uma cópia com a família renomeada (mesmo tamanho de nome, ASCII e UTF-16)
  const fontsSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts');
  const swap = (buf, from, to) => {
    for (const enc of ['latin1', 'utf16le']) {
      let a = Buffer.from(from, enc);
      let b = Buffer.from(to, enc);
      if (enc === 'utf16le') {
        a = Buffer.from(a).swap16();
        b = Buffer.from(b).swap16();
      }
      for (let i = buf.indexOf(a); i >= 0; i = buf.indexOf(a, i + b.length)) b.copy(buf, i);
    }
    return buf;
  };
  fs.copyFileSync(path.join(fontsSrc, 'trebuc.ttf'), path.join(dir, 'trebuc.ttf'));
  fs.writeFileSync(path.join(dir, 'outra.ttf'), swap(fs.readFileSync(path.join(fontsSrc, 'trebucit.ttf')), 'Trebuchet MS', 'Lunio Teste1'));
  const r = spawnSync(
    process.env.FFMPEG_PATH || 'ffmpeg',
    [
      '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=duration=20:size=320x180:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=20',
      '-i', path.join(dir, 'en.ass'), '-i', path.join(dir, 'pt.ass'),
      '-attach', path.join(dir, 'trebuc.ttf'), '-metadata:s:t:0', 'mimetype=font/ttf', '-metadata:s:t:0', 'filename=trebuc.ttf',
      '-attach', path.join(dir, 'outra.ttf'), '-metadata:s:t:1', 'mimetype=font/ttf', '-metadata:s:t:1', 'filename=outra.ttf',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map', '4:s',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-c:s', 'ass',
      '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'language=por',
      '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=por',
      subsFile,
    ],
    { encoding: 'utf-8' }
  );
  if (r.status !== 0) {
    console.error('Não consegui gerar legendas.mkv:', r.stderr || r.error);
    process.exit(1);
  }
  fs.writeFileSync(subsStamp, 'ok');
}

// Vídeos curtos em outros codecs, para testar o aviso de "o navegador não decodifica". Melhor esforço: se o FFmpeg não
// tiver o encoder (libx265, libsvtav1), o arquivo não existe e o teste correspondente é pulado.
const codecFiles = {
  'codec-hevc.mkv': ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'],
  'codec-hevc10.mkv': ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'],
  'codec-av1.mkv': ['-c:v', 'libsvtav1', '-preset', '12', '-pix_fmt', 'yuv420p'],
  'codec-h264-10bit.mkv': ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le'],
};
for (const [name, videoArgs] of Object.entries(codecFiles)) {
  const out = path.join(dir, name);
  if (fs.existsSync(out)) continue;
  const r = spawnSync(
    process.env.FFMPEG_PATH || 'ffmpeg',
    ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', ...videoArgs, '-c:a', 'aac', '-shortest', out],
    { encoding: 'utf-8' }
  );
  if (r.status !== 0) {
    fs.rmSync(out, { force: true });
    console.warn(`Sem ${name} (o FFmpeg não tem o encoder): o teste desse codec será pulado.`);
  }
}

http
  .createServer((req, res) => {
    if (req.url === '/ready') return void res.end('ok');
    const name = path.basename((req.url || '').split('?')[0]);
    const codecFile = codecFiles[name] ? path.join(dir, name) : null;
    if (codecFile && !fs.existsSync(codecFile)) return void res.writeHead(404).end();
    const served = codecFile || (name === 'legendas.mkv' ? subsFile : file);
    const st = fs.statSync(served);
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]);
      const end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      res.writeHead(206, { 'Content-Type': 'video/x-matroska', 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
      return void fs.createReadStream(served, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(served).pipe(res);
  })
  .listen(3101, '127.0.0.1', () => console.log('fixture em http://127.0.0.1:3101/teste.mkv'));
