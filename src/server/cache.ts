/**
 * Cache em memória com teto e validade, para o que o servidor guarda por vídeo (faixas, planos de HLS).
 * Um Map simples cresceria a cada vídeo novo até o próximo restart.
 *
 * - `max`: passou disso, sai quem foi usado há mais tempo (a ordem do Map é a ordem de uso).
 * - `ttlMs`: sem uso por esse tempo, a entrada some. Ler (`get`) conta como uso.
 */
export class BoundedCache<V> {
  private map = new Map<string, { value: V; at: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  private expired(at: number) {
    return this.now() - at > this.ttlMs;
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.expired(e.at)) {
      this.map.delete(key);
      return undefined;
    }
    // Reinsere no fim: é o "mais recente" para o teto e para a validade
    this.map.delete(key);
    this.map.set(key, { value: e.value, at: this.now() });
    return e.value;
  }

  /** Existe e não expirou? Não conta como uso. */
  has(key: string): boolean {
    const e = this.map.get(key);
    return !!e && !this.expired(e.at);
  }

  set(key: string, value: V): this {
    this.map.delete(key);
    this.map.set(key, { value, at: this.now() });
    this.trim();
    return this;
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  /** Remove as entradas em que `pred` é verdadeiro; devolve quantas. */
  deleteWhere(pred: (key: string, value: V) => boolean): number {
    let n = 0;
    for (const [k, e] of Array.from(this.map)) {
      if (pred(k, e.value)) {
        this.map.delete(k);
        n++;
      }
    }
    return n;
  }

  clear() {
    this.map.clear();
  }

  /** Os valores guardados (sem contar como uso). */
  *values(): IterableIterator<V> {
    for (const e of this.map.values()) yield e.value;
  }

  get size() {
    return this.map.size;
  }

  /** Tira as expiradas (as mais antigas ficam na frente) e o excesso. */
  private trim() {
    for (const [k, e] of this.map) {
      if (!this.expired(e.at)) break;
      this.map.delete(k);
    }
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
