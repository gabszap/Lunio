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
    const check = () => void screenApi.isEnabled().then((v) => alive && setEnabled(v));
    check();
    // Falha momentânea da consulta não pode deixar a opção "Indisponível" para sempre: tenta de novo enquanto estiver desligada
    const retry = enabled ? null : setInterval(check, 20_000);
    return () => {
      alive = false;
      if (retry) clearInterval(retry);
    };
  }, [discord, hostCapable, enabled]);

  return screenMenuState({ discord, hostCapable, enabled });
}
