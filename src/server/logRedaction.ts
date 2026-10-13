/**
 * Os links de CDN/Torrentio carregam o token do usuário no caminho ou na query (`/resolve/torbox/<token>/…`,
 * `?token=…`). O stderr do FFmpeg e mensagens de erro imprimem a URL inteira, então o token ia parar no journal.
 * Aqui toda URL com caminho ou query vira `https://host/…` antes de chegar ao console.
 */

const URL_WITH_PATH = /(https?:\/\/[^\s/'"<>`)\]]+)\/[^\s'"<>`)\]]*/gi;

/** `https://host/qualquer/coisa?token=x` → `https://host/…`. URLs sem caminho (`http://localhost:3000`) ficam como estão. */
export function redactUrlsInText(text: string): string {
  return text.replace(URL_WITH_PATH, '$1/…');
}

function redactArg(arg: unknown): unknown {
  if (typeof arg === 'string') return redactUrlsInText(arg);
  if (arg instanceof Error) return redactUrlsInText(arg.stack || `${arg.name}: ${arg.message}`);
  return arg;
}

let installed = false;

/** Passa todo `console.log/info/warn/error` pelo redator. Idempotente. */
export function installLogRedaction() {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => original(...args.map(redactArg));
  }
}
