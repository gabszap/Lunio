import { useEffect, useState } from 'react';
import { discordManager } from '../../lib/discord';
import { screenCapabilities } from '../../lib/screen';
import { screenApi } from '../../lib/screen/api';
import { screenMenuState } from '../../lib/screen/availability';

/** A opção "Compartilhar sua tela" da Home está disponível? (servidor com a flag ligada + navegador que sabe transmitir) */
export function useScreenMenu(): 'available' | 'checking' | 'unavailable' {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const discord = discordManager.getState().isEmbedded;
  const hostCapable = screenCapabilities().host;

  useEffect(() => {
    if (discord || !hostCapable) return;
    let alive = true;
    void screenApi.isEnabled().then((v) => alive && setEnabled(v));
    return () => {
      alive = false;
    };
  }, [discord, hostCapable]);

  return screenMenuState({ discord, hostCapable, enabled });
}
