/**
 * O projeto se chamava StreamPlayer: renomeia as chaves antigas (`streamplayer_*`) para `lunio_*`,
 * sem sobrescrever o que já existe com o nome novo. Roda uma vez, na subida do app.
 */
const OLD_PREFIX = 'streamplayer_';
const NEW_PREFIX = 'lunio_';

function migrate(storage: Storage) {
  const old: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(OLD_PREFIX)) old.push(key);
  }
  for (const key of old) {
    const next = NEW_PREFIX + key.slice(OLD_PREFIX.length);
    const value = storage.getItem(key);
    if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
    storage.removeItem(key);
  }
}

export function migrateLegacyStorage() {
  for (const get of [() => localStorage, () => sessionStorage]) {
    try {
      migrate(get());
    } catch {
      // armazenamento indisponível
    }
  }
}
