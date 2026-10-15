import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Dot, GhostButton, Spinner, cx } from '../ui';
import { COMMIT, REPO_URL } from './HomeLayout';
import { t } from '../../lib/i18n';
import { formatBytes } from '../../lib/recent';

interface StatusTabProps {
  environment: 'discord' | 'web';
  room: { connected: boolean; code: string; members: number; isHost: boolean };
}

interface StatusReport {
  rooms: number;
  people: number;
  uptimeSeconds: number;
  cache?: {
    bytes: number;
    limitBytes: number;
    uploads: { bytes: number; limitBytes: number; count: number };
    disk: { freeBytes: number; totalBytes: number } | null;
    lastSweep: { at: number; byAge: number; byLimit: number; freedBytes: number } | null;
  };
  ffmpeg: { found: boolean; version?: string };
  python: { found: boolean; version?: string; tooOld: boolean };
}

type Tone = 'success' | 'warning' | 'error';
interface Component {
  id: string;
  label: string;
  tone: Tone;
  detail: string;
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

/** Ping do servidor: mediana de 3 pedidos (o primeiro paga DNS/TLS; a mediana evita um pico isolado). */
async function measurePing(): Promise<{ ok: boolean; ms: number }> {
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await timed(`/api/room?id=STATUS&_=${Date.now()}${i}`);
    if (!r.ok) return r;
    samples.push(r.ms);
  }
  samples.sort((a, b) => a - b);
  return { ok: true, ms: samples[1] };
}

/** Velocidade daqui até o servidor (Mbit/s): baixa 4 MiB e mede do 1º chunk em diante (sem contar a latência inicial). */
async function measureSpeed(): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(`/api/speed?_=${Date.now()}`, { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok || !r.body) return null;
    const reader = r.body.getReader();
    let bytes = 0;
    let start = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!start) start = performance.now();
      else bytes += value.length;
    }
    const secs = (performance.now() - start) / 1000;
    return bytes > 0 && secs > 0 ? (bytes * 8) / secs / 1e6 : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** "há 12 min" / "há 3 h" / "há 2 d" a partir de um instante em ms. */
function timeAgo(at: number): string {
  const min = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (min < 1) return t('agora há pouco');
  if (min < 60) return t('há {n} min', { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t('há {n} h', { n: hours });
  return t('há {n} d', { n: Math.floor(hours / 24) });
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(seconds / 60))}min`;
}

const Stat: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div>
    <div className="text-[12px] uppercase tracking-[0.06em] text-lu-muted">{label}</div>
    <div className="mt-1 text-[28px] font-medium leading-none tabular">{value}</div>
  </div>
);

const Metric: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="min-w-0">
    <div className="text-[13px] text-lu-muted">{label}</div>
    <div className="mt-1 text-[16px] font-medium tabular truncate">{children}</div>
  </div>
);

export const StatusTab: React.FC<StatusTabProps> = ({ environment, room }) => {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const [ping, setPing] = useState<number | null>(null);
  const [speed, setSpeed] = useState<number | null | 'measuring'>('measuring');
  const [catalogOk, setCatalogOk] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setSpeed('measuring');
    // Ping primeiro e sozinho: a medição de velocidade ocuparia a conexão e inflaria o número
    const pingResult = await measurePing();
    setServerDown(!pingResult.ok);
    setPing(pingResult.ok ? pingResult.ms : null);

    const [status, catalog] = await Promise.all([
      fetch('/api/status', { cache: 'no-store' })
        .then((r) => (r.ok ? (r.json() as Promise<StatusReport>) : null))
        .catch(() => null),
      timed('https://v3-cinemeta.strem.io/manifest.json'),
    ]);
    setReport(status);
    setCatalogOk(catalog.ok);
    setRunning(false);

    setSpeed(pingResult.ok ? await measureSpeed() : null);
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const components: Component[] = [];
  if (report) {
    components.push({
      id: 'ffmpeg',
      label: 'FFmpeg',
      tone: report.ffmpeg.found ? 'success' : 'error',
      detail: report.ffmpeg.found
        ? t('Encontrado{version}. Faixas, troca de áudio e legendas disponíveis.', { version: report.ffmpeg.version ? ` (${report.ffmpeg.version})` : '' })
        : t('Não encontrado. Troca de áudio e leitura de faixas não vão funcionar.'),
    });
    components.push({
      id: 'python',
      label: 'Python',
      tone: report.python.found ? 'success' : 'warning',
      detail: report.python.found
        ? t('Encontrado{version}. Extração rápida de legendas disponível.', { version: report.python.version ? ` (${report.python.version})` : '' })
        : report.python.tooOld
        ? t('Versão {version} é antiga (precisa de 3.10+). Legendas usam o FFmpeg, mais lento.', { version: report.python.version ?? '' })
        : t('Não encontrado. Legendas usam o FFmpeg, mais lento.'),
    });
  }
  if (catalogOk !== null) {
    components.push({
      id: 'catalog',
      label: t('Catálogo'),
      tone: catalogOk ? 'success' : 'warning',
      detail: catalogOk ? t('Cinemeta respondendo') : t('Cinemeta fora do ar. Links de stream continuam funcionando.'),
    });
  }

  const checking = running && !report && !serverDown;
  const available = !serverDown && report !== null;
  const dash = <span className="text-lu-muted">—</span>;

  return (
    <div className="w-full max-w-[960px] mx-auto flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="m-0 text-[28px] sm:text-[32px] font-semibold tracking-[-0.02em] leading-tight">{t('Servidor')}</h1>
          <p className="mt-1.5 mb-0 text-[14px] text-lu-muted">
            {checking ? t('Verificando…') : available ? t('Servidor disponível') : t('Servidor fora do ar. Salas e envios não vão funcionar.')}
          </p>
        </div>
        <GhostButton onClick={run} disabled={running} aria-label={t('Verificar de novo')}>
          <RefreshCw size={16} className={running ? 'animate-lu-spin' : ''} />
          <span className="hidden sm:inline">{t('Verificar de novo')}</span>
        </GhostButton>
      </div>

      <div className="flex gap-10">
        <Stat label={t('Salas abertas')} value={report ? report.rooms : dash} />
        <Stat label={t('Pessoas assistindo')} value={report ? report.people : dash} />
      </div>

      <section className="w-full box-border p-5 sm:p-6 rounded-[20px] bg-lu-surface border border-lu-border shadow-[0_24px_64px_rgba(0,0,0,0.45)]">
        <div className="flex items-center gap-3 mb-5">
          <span className="font-mono text-[15px] font-semibold truncate">{window.location.host}</span>
          <span
            className={cx(
              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium',
              checking ? 'bg-lu-bg2 text-lu-muted' : available ? 'bg-lu-success/15 text-lu-success' : 'bg-lu-error/15 text-lu-error'
            )}
          >
            {checking ? <Spinner size={12} /> : <Dot tone={available ? 'success' : 'error'} />}
            {checking ? t('Verificando…') : available ? t('Disponível') : t('Fora do ar')}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-5">
          <Metric label={t('Ping')}>{ping !== null ? `${ping} ms` : dash}</Metric>
          <Metric label={t('Velocidade daqui')}>
            {speed === 'measuring' ? (
              <span className="inline-flex items-center gap-2 text-lu-muted">
                <Spinner size={13} />
                {t('Medindo…')}
              </span>
            ) : speed !== null ? (
              `${speed.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} Mbit/s`
            ) : (
              dash
            )}
          </Metric>
          <Metric label={t('No ar')}>{report ? formatUptime(report.uptimeSeconds) : dash}</Metric>
          {report?.cache && (
            <>
              <Metric label={t('Cache')}>
                {t('{size} de {limit}', { size: formatBytes(report.cache.bytes), limit: formatBytes(report.cache.limitBytes) })}
              </Metric>
              <Metric label={t('Envios')}>
                <span title={t('{n} arquivo(s) enviado(s)', { n: report.cache.uploads.count })}>
                  {t('{size} de {limit}', { size: formatBytes(report.cache.uploads.bytes), limit: formatBytes(report.cache.uploads.limitBytes) })}
                </span>
              </Metric>
              <Metric label={t('Disco livre')}>{report.cache.disk ? formatBytes(report.cache.disk.freeBytes) : dash}</Metric>
              <Metric label={t('Última limpeza')}>
                {report.cache.lastSweep ? (
                  <span
                    title={t('{n} item(ns) removido(s), {size} liberados', {
                      n: report.cache.lastSweep.byAge + report.cache.lastSweep.byLimit,
                      size: formatBytes(report.cache.lastSweep.freedBytes),
                    })}
                  >
                    {timeAgo(report.cache.lastSweep.at)}
                  </span>
                ) : (
                  <span className="text-lu-muted">{t('Ainda não rodou')}</span>
                )}
              </Metric>
            </>
          )}
          <Metric label={t('Versão')}>
            {COMMIT === 'dev' ? (
              <span className="font-mono">dev</span>
            ) : (
              <a
                href={`${REPO_URL}/commit/${COMMIT}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-lu-text no-underline hover:text-lu-accent"
              >
                {COMMIT}
              </a>
            )}
          </Metric>
        </div>

        {components.length > 0 && (
          <ul className="list-none m-0 mt-6 pt-5 border-t border-lu-border flex flex-wrap gap-x-5 gap-y-2">
            {components.map((c) => (
              <li key={c.id} title={c.detail} className="inline-flex items-center gap-2 text-[13px] text-lu-muted">
                <Dot tone={c.tone} />
                {c.label}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="m-0 text-[13px] text-lu-muted">
        {environment === 'discord' ? 'Discord Activity' : t('Navegador (Web Standalone)')}
        {' · '}
        {room.connected
          ? t('{code} · {n} {people} · você é {role}', { code: room.code, n: room.members, people: room.members === 1 ? t('pessoa') : t('pessoas'), role: room.isHost ? t('o Host') : t('espectador') })
          : t('Nenhuma. Você está no Modo Solo.')}
      </p>
    </div>
  );
};
