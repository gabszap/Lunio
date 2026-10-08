import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Dot, GhostButton, HomeCard, Spinner } from '../ui';
import { t } from '../../lib/i18n';

interface Check {
  id: string;
  label: string;
  detail: string;
  state: 'checking' | 'ok' | 'warn' | 'down';
  ms?: number;
}

interface StatusTabProps {
  environment: 'discord' | 'web';
  room: { connected: boolean; code: string; members: number; isHost: boolean };
}

interface ToolsReport {
  ffmpeg: { found: boolean; version?: string };
  python: { found: boolean; version?: string; tooOld: boolean };
}

function toolChecks(tools: ToolsReport | null): Check[] {
  if (!tools) return [];
  return [
    {
      id: 'ffmpeg',
      label: 'FFmpeg',
      detail: tools.ffmpeg.found
        ? t('Encontrado{version}. Faixas, troca de áudio e legendas disponíveis.', { version: tools.ffmpeg.version ? ` (${tools.ffmpeg.version})` : '' })
        : t('Não encontrado. Troca de áudio e leitura de faixas não vão funcionar.'),
      state: tools.ffmpeg.found ? 'ok' : 'down',
    },
    {
      id: 'python',
      label: 'Python',
      detail: tools.python.found
        ? t('Encontrado{version}. Extração rápida de legendas disponível.', { version: tools.python.version ? ` (${tools.python.version})` : '' })
        : tools.python.tooOld
        ? t('Versão {version} é antiga (precisa de 3.10+). Legendas usam o FFmpeg, mais lento.', { version: tools.python.version ?? '' })
        : t('Não encontrado. Legendas usam o FFmpeg, mais lento.'),
      state: tools.python.found ? 'ok' : 'warn',
    },
  ];
}

async function timed(url: string): Promise<{ ok: boolean; ms: number }> {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return { ok: r.ok, ms: Math.round(performance.now() - t0) };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - t0) };
  }
}

export const StatusTab: React.FC<StatusTabProps> = ({ environment, room }) => {
  const [checks, setChecks] = useState<Check[]>([]);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setChecks([
      { id: 'server', label: t('Servidor do Lunio'), detail: t('Salas, proxy de mídia e envios'), state: 'checking' },
      { id: 'catalog', label: t('Catálogo'), detail: t('Metadados de filmes e séries (Cinemeta)'), state: 'checking' },
    ]);
    const [server, catalog, tools] = await Promise.all([
      timed('/api/room?id=STATUS'),
      timed('https://v3-cinemeta.strem.io/manifest.json'),
      fetch('/api/status', { cache: 'no-store' })
        .then((r) => (r.ok ? (r.json() as Promise<ToolsReport>) : null))
        .catch(() => null),
    ]);
    setChecks([
      {
        id: 'server',
        label: t('Servidor do Lunio'),
        detail: server.ok ? t('Salas, proxy de mídia e envios respondendo') : t('Sem resposta. Salas e envios não vão funcionar.'),
        state: server.ok ? 'ok' : 'down',
        ms: server.ms,
      },
      {
        id: 'catalog',
        label: t('Catálogo'),
        detail: catalog.ok ? t('Cinemeta respondendo') : t('Cinemeta fora do ar. Links de stream continuam funcionando.'),
        state: catalog.ok ? 'ok' : 'warn',
        ms: catalog.ms,
      },
      ...toolChecks(tools),
    ]);
    setRunning(false);
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const rows: Check[] = [
    ...checks,
    {
      id: 'room',
      label: t('Sala atual'),
      detail: room.connected
        ? t('{code} · {n} {people} · você é {role}', { code: room.code, n: room.members, people: room.members === 1 ? t('pessoa') : t('pessoas'), role: room.isHost ? t('o Host') : t('espectador') })
        : t('Nenhuma. Você está no Modo Solo.'),
      state: room.connected ? 'ok' : 'warn',
    },
    {
      id: 'env',
      label: t('Ambiente'),
      detail: environment === 'discord' ? 'Discord Activity' : t('Navegador (Web Standalone)'),
      state: 'ok',
    },
  ];

  return (
    <HomeCard>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="m-0 text-[22px] sm:text-[24px] font-semibold tracking-[-0.02em] leading-tight">{t('Status')}</h1>
          <p className="mt-1.5 mb-0 text-[14px] text-lu-muted">{t('O que está de pé agora.')}</p>
        </div>
        <GhostButton onClick={run} disabled={running} aria-label={t('Verificar de novo')}>
          <RefreshCw size={16} className={running ? 'animate-lu-spin' : ''} />
          <span className="hidden sm:inline">{t('Verificar de novo')}</span>
        </GhostButton>
      </div>

      <ul className="list-none m-0 p-0 flex flex-col gap-2">
        {rows.map((c) => (
          <li key={c.id} className="flex items-center gap-3.5 px-4 py-3 rounded-[14px] bg-lu-bg2 border border-lu-border">
            <span className="w-4 flex justify-center flex-none">
              {c.state === 'checking' ? (
                <Spinner size={14} className="text-lu-accent" />
              ) : (
                <Dot tone={c.state === 'ok' ? 'success' : c.state === 'warn' ? 'warning' : 'error'} />
              )}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[14px] font-semibold">{c.label}</span>
              <span className="block text-[13px] text-lu-muted">{c.state === 'checking' ? t('Verificando…') : c.detail}</span>
            </span>
            {c.ms !== undefined && c.state !== 'checking' && (
              <span className="text-[12px] tabular text-lu-muted flex-none">{c.ms} ms</span>
            )}
          </li>
        ))}
      </ul>
    </HomeCard>
  );
};
