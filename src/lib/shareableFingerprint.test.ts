import { describe, expect, it } from 'vitest';
import { shareableFingerprint } from './media';

describe('shareableFingerprint', () => {
  it('link do Torrentio: identidade pelo infoHash, sem a chave de quem o gerou', () => {
    const fp = shareableFingerprint('https://torrentio.strem.fun/resolve/torbox/CHAVE-SECRETA/abcdef0123456789abcdef0123456789abcdef01/null/2/Anime%20-%2001.mkv');
    expect(fp).toMatch(/^ih:abcdef0123456789abcdef0123456789abcdef01\|f:2\|n:/);
    expect(fp).not.toContain('CHAVE-SECRETA');
  });

  it('link sem identidade própria não é repassado (a forma `url:` carregaria o link)', () => {
    expect(shareableFingerprint('https://api.exemplo.test/dl?token=SEGREDO&f=1')).toBeUndefined();
  });
});
