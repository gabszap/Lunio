import React, { useEffect, useState } from 'react';
import { Dot } from '../ui';
import { t } from '../../lib/i18n';

interface PresenceData {
  rooms: number;
  people: number;
}

const PRESENCE_TIMEOUT_MS = 5000;

export const HomeHero: React.FC = () => {
  const [presence, setPresence] = useState<PresenceData | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), PRESENCE_TIMEOUT_MS);

    fetch('/api/presence', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (
          data &&
          typeof data === 'object' &&
          'people' in data &&
          typeof (data as { people: unknown }).people === 'number' &&
          Number.isFinite((data as { people: number }).people)
        ) {
          const rooms =
            'rooms' in data && typeof (data as { rooms: unknown }).rooms === 'number'
              ? (data as { rooms: number }).rooms
              : 0;
          setPresence({
            rooms,
            people: (data as { people: number }).people,
          });
        }
      })
      .catch(() => {
        // Silencia falhas de rede/abort e mantém o fallback padrão na pílula
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
      });

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  const hasPeople = presence !== null && presence.people > 0;

  return (
    <div className="flex flex-col items-center text-center max-w-[640px] w-full">
      <div className="rounded-full bg-lu-bg2/90 border border-lu-border px-3.5 py-1.5 text-[12.5px] font-medium text-lu-muted inline-flex items-center gap-2 mb-4">
        {hasPeople ? (
          <>
            <Dot tone="success" pulse />
            <span>
              <strong className="font-semibold text-lu-text tabular">{presence.people.toLocaleString()}</strong>{' '}
              {presence.people === 1 ? t('pessoa utilizando o Lunio') : t('pessoas utilizando o Lunio')}
            </span>
          </>
        ) : (
          <>
            <Dot tone="success" />
            <span>{t('Grátis · direto do navegador')}</span>
          </>
        )}
      </div>

      <h1 className="text-[34px] sm:text-[46px] font-bold tracking-[-0.03em] leading-[1.08] text-lu-text text-center m-0">
        {t('Assista junto com')}{' '}
        <span className="text-lu-accent">{t('a galera')}</span>
      </h1>

      <p className="max-w-[520px] mt-3 mb-0 text-[14.5px] sm:text-[15.5px] text-lu-muted text-center leading-relaxed">
        {t('Crie uma sala, chame os amigos pelo link e escolha o que assistir lá dentro. Com chat, legendas e transmissão de tela.')}
      </p>
    </div>
  );
};
