import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

/**
 * Descobre FFmpeg e Python uma vez e guarda o resultado.
 *  - FFmpeg:  FFMPEG_PATH → `ffmpeg` no PATH → caminhos conhecidos do Windows (mpv, C:\ffmpeg)
 *  - Python:  PYTHON_PATH → `python3` → `python` → `py -3` (Windows), exigindo versão >= 3.10
 * A detecção é preguiçosa: `npm run build` carrega a config do Vite e não precisa (nem deve) rodar isso.
 */

const MIN_PYTHON: [number, number] = [3, 10];

export interface FfmpegInfo {
  found: boolean;
  /** Executável a usar no spawn (cai em 'ffmpeg' se nada foi achado, para o erro aparecer no spawn). */
  path: string;
  version?: string;
}

export interface PythonInfo {
  found: boolean;
  command: string;
  /** Argumentos que vêm antes dos do script (ex.: `-3` do launcher `py`). */
  args: string[];
  version?: string;
  /** Achou um Python, mas abaixo do mínimo. */
  tooOld?: boolean;
}

export interface ToolStatus {
  ffmpeg: FfmpegInfo;
  python: PythonInfo;
}

let cached: ToolStatus | null = null;

function run(command: string, args: string[]): string | null {
  try {
    const r = spawnSync(command, args, { encoding: 'utf-8', timeout: 8000, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    return `${r.stdout || ''}${r.stderr || ''}`;
  } catch {
    return null;
  }
}

function detectFfmpeg(): FfmpegInfo {
  const candidates: string[] = [];
  if (process.env.FFMPEG_PATH?.trim()) candidates.push(process.env.FFMPEG_PATH.trim());
  candidates.push('ffmpeg');
  if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\mpv\\ffmpeg.exe', 'C:\\ffmpeg\\ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe');
  }
  for (const candidate of candidates) {
    // Caminho absoluto que não existe: nem tenta executar
    if (/[\\/]/.test(candidate) && !fs.existsSync(candidate)) continue;
    const out = run(candidate, ['-version']);
    if (out && /ffmpeg version/i.test(out)) {
      return { found: true, path: candidate, version: /ffmpeg version (\S+)/i.exec(out)?.[1] };
    }
  }
  return { found: false, path: 'ffmpeg' };
}

function detectPython(): PythonInfo {
  const candidates: Array<{ command: string; args: string[] }> = [];
  if (process.env.PYTHON_PATH?.trim()) candidates.push({ command: process.env.PYTHON_PATH.trim(), args: [] });
  candidates.push({ command: 'python3', args: [] }, { command: 'python', args: [] });
  if (process.platform === 'win32') candidates.push({ command: 'py', args: ['-3'] });

  let tooOld: PythonInfo | null = null;
  for (const c of candidates) {
    if (/[\\/]/.test(c.command) && !fs.existsSync(c.command)) continue;
    const out = run(c.command, [...c.args, '-c', "import sys; print('%d.%d.%d' % sys.version_info[:3])"]);
    const m = out && /(\d+)\.(\d+)\.(\d+)/.exec(out);
    if (!m) continue;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    const version = `${m[1]}.${m[2]}.${m[3]}`;
    if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) {
      return { found: true, command: c.command, args: c.args, version };
    }
    tooOld ??= { found: false, command: c.command, args: c.args, version, tooOld: true };
  }
  return tooOld ?? { found: false, command: 'python3', args: [] };
}

export function getTools(): ToolStatus {
  if (!cached) cached = { ffmpeg: detectFfmpeg(), python: detectPython() };
  return cached;
}

export function ffmpegBin(): string {
  return getTools().ffmpeg.path;
}

/** Linhas de log do início do servidor: o que foi achado e o que isso desliga. */
export function logToolStatus() {
  const { ffmpeg, python } = getTools();
  if (ffmpeg.found) console.log(`[Ferramentas] FFmpeg ${ffmpeg.version || ''} em "${ffmpeg.path}"`);
  else {
    console.warn(
      '[Ferramentas] FFmpeg NÃO encontrado: troca de áudio, leitura de faixas e extração de legendas/fontes não vão funcionar. ' +
        'Instale o FFmpeg ou defina FFMPEG_PATH no .env.'
    );
  }
  if (python.found) console.log(`[Ferramentas] Python ${python.version} (${[python.command, ...python.args].join(' ')})`);
  else if (python.tooOld) {
    console.warn(`[Ferramentas] Python ${python.version} é antigo demais (precisa de 3.10+): legendas usam o FFmpeg, mais lento.`);
  } else {
    console.warn('[Ferramentas] Python 3.10+ NÃO encontrado: legendas usam o FFmpeg, mais lento. Defina PYTHON_PATH no .env se necessário.');
  }
}

/**
 * Mata o processo de forma portável. No Windows `SIGKILL` encerra só o processo, não os filhos;
 * `taskkill /T` derruba a árvore. No Linux/macOS o SIGKILL basta (FFmpeg e o extrator não criam filhos).
 */
export function killTree(proc: ChildProcess) {
  const pid = proc.pid;
  if (!pid || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {
        try { proc.kill(); } catch {}
      });
    } catch {
      try { proc.kill(); } catch {}
    }
    return;
  }
  try { proc.kill('SIGKILL'); } catch {}
}
