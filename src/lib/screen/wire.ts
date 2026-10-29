/**
 * Cifra por quadro da transmissão de tela (AES-GCM 256).
 *
 * Formato do payload: `[stamp f64 BE 8][quadro-chave 1][época & 255, 1]` em claro e autenticado (AAD), depois
 * `[iv 12][cifrado + tag]`. O IV é `[faixa 1][3 zeros][contador u64 BE 8]` e o contador zera a cada chave nova.
 * A chave nunca passa pelo relay: vai pela sala (WebSocket) só para quem está nela.
 */

export interface ScreenKeyMaterial {
  epoch: number;
  /** Base64 de 32 bytes. */
  key: string;
}

export type TrackKind = 'video' | 'audio';

export interface OpenedFrame {
  stamp: number;
  key: boolean;
  data: Uint8Array;
}

const HEADER_BYTES = 10;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEPT_KEYS = 4;
const TRACK_BYTE: Record<TrackKind, number> = { video: 1, audio: 2 };

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function generateScreenKey(epoch: number): Promise<ScreenKeyMaterial> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return { epoch, key: toBase64(raw) };
}

const importKey = (m: ScreenKeyMaterial, usage: 'encrypt' | 'decrypt') =>
  crypto.subtle.importKey('raw', fromBase64(m.key) as BufferSource, 'AES-GCM', false, [usage]);

export class FrameSealer {
  private aes: CryptoKey | null = null;
  private currentEpoch = 0;
  private counter = 0;

  get epoch(): number {
    return this.currentEpoch;
  }

  async setKey(m: ScreenKeyMaterial): Promise<void> {
    this.aes = await importKey(m, 'encrypt');
    this.currentEpoch = m.epoch;
    this.counter = 0;
  }

  async seal(track: TrackKind, stamp: number, isKey: boolean, data: Uint8Array): Promise<Uint8Array> {
    const aes = this.aes;
    if (!aes) throw new Error('Sem chave de transmissão.');
    const header = new Uint8Array(HEADER_BYTES);
    new DataView(header.buffer).setFloat64(0, stamp);
    header[8] = isKey ? 1 : 0;
    header[9] = this.currentEpoch & 255;

    // O contador sobe antes do await: quadros selados ao mesmo tempo nunca dividem um IV
    const n = this.counter++;
    const iv = new Uint8Array(IV_BYTES);
    iv[0] = TRACK_BYTE[track];
    const dv = new DataView(iv.buffer);
    dv.setUint32(4, Math.floor(n / 2 ** 32));
    dv.setUint32(8, n % 2 ** 32);

    const cipher = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, aes, data as BufferSource),
    );
    const out = new Uint8Array(HEADER_BYTES + IV_BYTES + cipher.byteLength);
    out.set(header, 0);
    out.set(iv, HEADER_BYTES);
    out.set(cipher, HEADER_BYTES + IV_BYTES);
    return out;
  }
}

export class FrameOpener {
  readonly counts = { ok: 0, noKey: 0, badTag: 0, malformed: 0 };
  private keys: Array<{ epoch: number; id: number; aes: CryptoKey }> = [];

  async addKey(m: ScreenKeyMaterial): Promise<void> {
    const aes = await importKey(m, 'decrypt');
    const id = m.epoch & 255;
    this.keys = this.keys.filter((k) => k.id !== id && k.epoch !== m.epoch);
    this.keys.push({ epoch: m.epoch, id, aes });
    this.keys.sort((a, b) => a.epoch - b.epoch);
    if (this.keys.length > KEPT_KEYS) this.keys = this.keys.slice(-KEPT_KEYS);
  }

  /** Nunca lança: quadro curto, sem chave ou adulterado vira `null` e entra nos contadores. */
  async open(payload: Uint8Array): Promise<OpenedFrame | null> {
    if (payload.length < HEADER_BYTES + IV_BYTES + TAG_BYTES) {
      this.counts.malformed++;
      return null;
    }
    const header = payload.subarray(0, HEADER_BYTES);
    const entry = this.keys.find((k) => k.id === header[9]);
    if (!entry) {
      this.counts.noKey++;
      return null;
    }
    try {
      const stamp = new DataView(payload.buffer, payload.byteOffset, HEADER_BYTES).getFloat64(0);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: payload.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES), additionalData: header },
        entry.aes,
        payload.subarray(HEADER_BYTES + IV_BYTES),
      );
      this.counts.ok++;
      return { stamp, key: header[8] === 1, data: new Uint8Array(plain) };
    } catch {
      this.counts.badTag++;
      return null;
    }
  }
}
