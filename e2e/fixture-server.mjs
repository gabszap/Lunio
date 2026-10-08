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

http
  .createServer((req, res) => {
    if (req.url === '/ready') return void res.end('ok');
    const st = fs.statSync(file);
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]);
      const end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      res.writeHead(206, { 'Content-Type': 'video/x-matroska', 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
      return void fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(3101, '127.0.0.1', () => console.log('fixture em http://127.0.0.1:3101/teste.mkv'));
