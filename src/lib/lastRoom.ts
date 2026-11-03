import { t } from './i18n';

/**
 * A última sala em que a pessoa esteve, guardada no navegador para o "Voltar à sala" da Home. Só o código e a hora: nada do vídeo nem da
 * sessão. As salas duram no máximo `ROOM_STATE_TTL_HOURS` (24 h) no servidor, então um registro mais velho que isso não vale.
 */

const KEY = 'lunio_last_room';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Gravar de novo na mesma sala só depois disto (o estado da sala chega o tempo todo). */
const TOUCH_GAP_MS = 30_000;
const CODE_RE = /^[A-Z0-9]{4,32}$/;

export interface LastRoom {
  code: string;
  /** Última vez em que a pessoa estava na sala (ms). */
  at: number;
}

export function loadLastRoom(now = Date.now()): LastRoom | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastRoom>;
    if (typeof v?.code !== 'string' || !CODE_RE.test(v.code) || typeof v.at !== 'number' || !Number.isFinite(v.at)) return null;
    return now - v.at > MAX_AGE_MS ? null : { code: v.code, at: v.at };
  } catch {
    return null;
  }
}

/** Marca que a pessoa está (ou acabou de estar) na sala. `force` ignora o intervalo mínimo entre gravações. */
export function saveLastRoom(code: string, now = Date.now(), force = false) {
  if (!CODE_RE.test(code)) return;
  try {
    const cur = loadLastRoom(now);
    if (!force && cur && cur.code === code && now - cur.at < TOUCH_GAP_MS) return;
    localStorage.setItem(KEY, JSON.stringify({ code, at: now } satisfies LastRoom));
  } catch {
    // armazenamento indisponível: só não lembra a sala
  }
}

export function clearLastRoom() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nada a limpar
  }
}

/** "agora há pouco", "há 5 min", "há 3 h" (já traduzido). */
export function agoLabel(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return t('agora há pouco');
  if (min < 60) return t('há {n} min', { n: min });
  return t('há {n} h', { n: Math.floor(min / 60) });
}
