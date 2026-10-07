import { useEffect, useRef, useState } from 'react';
import { discordManager } from '../../lib/discord';

/**
 * Dentro da Discord Activity, informa à Rich Presence o ponto do vídeo (tocando ou pausado) e a duração.
 * Só reporta em play/pause, seek e quando a duração é conhecida: o Discord limita a frequência das atualizações.
 */
export function useDiscordPresence(args: { paused: boolean; currentTime: number; duration: number }) {
  const { paused, currentTime, duration } = args;
  const [jump, setJump] = useState(0);
  const posRef = useRef(currentTime);
  const last = useRef({ t: currentTime, at: Date.now() });
  posRef.current = currentTime;

  // Seek: a posição saltou além do que o relógio explicaria
  useEffect(() => {
    const now = Date.now();
    const expected = last.current.t + (paused ? 0 : (now - last.current.at) / 1000);
    if (Math.abs(currentTime - expected) > 4) setJump((j) => j + 1);
    last.current = { t: currentTime, at: now };
  }, [currentTime, paused]);

  useEffect(() => {
    if (!discordManager.isDiscordActivity()) return;
    const id = setTimeout(() => discordManager.setPlayback({ paused, position: posRef.current, duration }), 1500);
    return () => clearTimeout(id);
  }, [paused, duration, jump]);

  useEffect(() => () => discordManager.setPlayback(null), []);
}
