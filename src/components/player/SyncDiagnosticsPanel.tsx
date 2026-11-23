import { useEffect, useState } from 'react';
import type { SyncDiagnostics } from '../../lib/syncDiagnostics';

const ms = (value: number | undefined) => value === undefined ? '—' : `${Math.round(value)} ms`;
const actions = {
  seek: 'Seek corretivo',
  rate_speedup: 'Aceleração por atraso',
  rate_slowdown: 'Desaceleração por adiantamento',
  none: 'Velocidade nominal',
};

export function SyncDiagnosticsPanel({ diagnostics }: { diagnostics: SyncDiagnostics }) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ReturnType<SyncDiagnostics['snapshot']>>();
  useEffect(() => {
    if (!open) return;
    const refresh = () => setSnapshot(diagnostics.snapshot());
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [diagnostics, open]);

  const metrics = snapshot && [
    ['Último drift', ms(snapshot.driftMs)],
    ['RTT', ms(snapshot.rtt)],
    ['Idade da timeline', ms(snapshot.ageMs)],
    ['Velocidade aplicada', snapshot.rate === undefined ? '—' : `${snapshot.rate.toFixed(3)}×`],
    ['Estado do player', snapshot.state ?? '—'],
    ['Seeks corretivos', snapshot.seeks],
    ['Drift absoluto P50', ms(snapshot.p50Ms)],
    ['Drift absoluto P95', ms(snapshot.p95Ms)],
  ];

  return (
    <details className="border-b border-lu-border bg-lu-bg2 text-[12px]" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="min-h-10 cursor-pointer px-4 py-3 font-medium hover:bg-white/5">
        Diagnóstico da sincronização
      </summary>
      {open && metrics && (
        <div className="px-4 pb-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            {metrics.map(([label, value]) => (
              <div key={label}>
                <dt className="text-lu-muted">{label}</dt>
                <dd className="mt-0.5 font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-lu-muted">Amostras de drift: {snapshot.sampleCount}</p>
          {snapshot.events.length > 0 && (
            <ol aria-label="Eventos de sincronização" className="mt-2 max-h-32 space-y-1 overflow-y-auto border-t border-lu-border pt-2">
              {[...snapshot.events].reverse().map((event, index) => (
                <li key={`${event.at}-${index}`} className="flex gap-2">
                  <time dateTime={new Date(event.at).toISOString()} className="shrink-0 tabular-nums text-lu-muted">
                    {new Date(event.at).toLocaleTimeString('pt-BR')}
                  </time>
                  <span>{'state' in event ? `Player: ${event.state}` : `${actions[event.action]} (${ms(event.driftMs)})`}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </details>
  );
}
