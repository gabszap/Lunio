/**
 * Envio de arquivo em pedaços para /api/upload (início → pedaços → conclusão).
 *
 * Um corpo só não passa por proxies com limite de requisição (a Cloudflare gratuita recusa mais de 100 MB). Em
 * pedaços cada requisição é pequena e, se a conexão cai, só o pedaço corrente se perde: o envio retoma de onde o
 * servidor confirmou, sozinho (rede/5xx) ou pelo botão "continuar" (a sessão fica guardada).
 */

export interface UploadSession {
  id: string;
}

export class UploadError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly received?: number
  ) {
    super(message);
  }
}

export interface ChunkedUploadOptions {
  file: File;
  signal: AbortSignal;
  /** Token atual da sala (lido a cada pedido: ele é renovado enquanto o envio dura). */
  getToken: () => string;
  /** Sessão de uma tentativa anterior para continuar dela; ausente ou inválida, começa uma nova. */
  session?: UploadSession | null;
  onSession?: (session: UploadSession) => void;
  /** Bytes já entregues ao servidor (confirmados + o pedaço em andamento) e de onde esta execução partiu. */
  onProgress?: (loaded: number, resumedFrom: number) => void;
  /** true enquanto espera para tentar um pedaço de novo. */
  onRetry?: (waiting: boolean) => void;
  /** Esperas entre as tentativas de um mesmo pedaço (ms). Os testes passam esperas curtas. */
  retryDelaysMs?: number[];
}

// `__lunioRetryDelays` é um gancho dos testes E2E (esperas curtas); em uso normal vale o padrão
const DEFAULT_RETRY_DELAYS_MS: number[] = (globalThis as { __lunioRetryDelays?: number[] }).__lunioRetryDelays ?? [1000, 2000, 4000, 8000, 15000];

const abortError = () => new DOMException('Envio cancelado', 'AbortError');

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Pedido JSON simples (início, estado, conclusão). */
async function call(method: string, url: string, token: string, signal: AbortSignal): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { method, headers: { 'X-Lunio-Token': token }, signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new UploadError('A conexão caiu durante o envio.', 0);
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // 204 ou corpo não-JSON
  }
  if (!res.ok) throw new UploadError(body?.error || `HTTP ${res.status}`, res.status, body?.code, body?.received);
  return body;
}

/** Um pedaço por XHR (é o que dá progresso de envio). */
function putChunk(url: string, token: string, blob: Blob, signal: AbortSignal, onProgress: (loaded: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const done = () => signal.removeEventListener('abort', onAbort);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      done();
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // corpo não-JSON (ex.: página de erro do proxy)
      }
      if (xhr.status >= 200 && xhr.status < 300 && typeof body?.received === 'number') return resolve(body.received);
      reject(new UploadError(body?.error || `HTTP ${xhr.status}`, xhr.status, body?.code, body?.received));
    };
    xhr.onerror = () => {
      done();
      reject(new UploadError('A conexão caiu durante o envio.', 0));
    };
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => {
      done();
      reject(abortError());
    };
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Lunio-Token', token);
    xhr.send(blob);
  });
}

/** Erro que vale a pena tentar de novo: rede caída, 5xx, 408/429 e 401 (token da sala sendo renovado). */
const isTransient = (e: UploadError) => e.status === 0 || e.status >= 500 || e.status === 408 || e.status === 429 || e.status === 401;

export async function uploadInChunks(opts: ChunkedUploadOptions): Promise<{ id: string; url: string; name: string; size: number; claim: string }> {
  const { file, signal, getToken } = opts;
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  // 1) Sessão: continua a de antes (se o servidor ainda a tem) ou começa uma
  let id = '';
  let chunkSize = 0;
  let received = 0;
  let claim = '';
  if (opts.session) {
    try {
      const st = await call('GET', `/api/upload/${opts.session.id}`, getToken(), signal);
      id = opts.session.id;
      received = st.received;
      chunkSize = st.chunkSize ?? 0;
      claim = st.claim ?? '';
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      if (!(err instanceof UploadError) || (err.status !== 404 && !isTransient(err))) throw err;
      // sessão perdida (expirou, servidor limpou): começa de novo abaixo
    }
  }
  if (!id) {
    const started = await call('POST', `/api/upload/start?name=${encodeURIComponent(file.name)}&size=${file.size}`, getToken(), signal);
    id = started.id;
    chunkSize = started.chunkSize;
    received = started.received ?? 0;
    claim = started.claim ?? '';
  }
  opts.onSession?.({ id });
  if (!chunkSize) chunkSize = 32 * 1024 * 1024; // servidor antigo que não informa o tamanho do pedaço
  const resumedFrom = received;
  opts.onProgress?.(received, resumedFrom);

  // 2) Pedaços, cada um com tentativas; a posição do servidor é sempre a verdade
  while (received < file.size) {
    const end = Math.min(received + chunkSize, file.size);
    let attempt = 0;
    for (;;) {
      try {
        const base = received;
        received = await putChunk(`/api/upload/${id}?offset=${base}`, getToken(), file.slice(base, end), signal, (loaded) =>
          opts.onProgress?.(base + loaded, resumedFrom)
        );
        opts.onRetry?.(false);
        opts.onProgress?.(received, resumedFrom);
        break;
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') throw err;
        if (!(err instanceof UploadError)) throw err;
        // O servidor diz onde está: continua dali (um pedaço que chegou mas cuja resposta se perdeu, por exemplo)
        if (err.status === 409 && err.code === 'offset_mismatch' && typeof err.received === 'number') {
          received = err.received;
          opts.onProgress?.(received, resumedFrom);
          break;
        }
        if (!isTransient(err) || attempt >= delays.length) throw err;
        opts.onRetry?.(true);
        await wait(delays[attempt++], signal);
        // Antes de repetir, confere o que o servidor realmente tem
        try {
          const st = await call('GET', `/api/upload/${id}`, getToken(), signal);
          received = st.received;
          opts.onProgress?.(received, resumedFrom);
        } catch (statusErr) {
          if ((statusErr as Error)?.name === 'AbortError') throw statusErr;
          if (statusErr instanceof UploadError && statusErr.status === 404) throw statusErr;
          // sem resposta ainda: tenta o pedaço mesmo assim na próxima volta
        }
        if (received >= end) break; // o pedaço já tinha chegado
      }
    }
  }

  // 3) Conclusão (também tentada de novo se a rede oscilar)
  for (let attempt = 0; ; attempt++) {
    try {
      const done = await call('POST', `/api/upload/${id}/finish`, getToken(), signal);
      return { id, url: done.url, name: done.name, size: done.size ?? file.size, claim: done.claim || claim };
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      if (!(err instanceof UploadError) || !isTransient(err) || attempt >= delays.length) throw err;
      opts.onRetry?.(true);
      await wait(delays[attempt], signal);
    }
  }
}
