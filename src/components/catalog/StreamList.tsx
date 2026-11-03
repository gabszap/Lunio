import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { VideoAddon } from '../../lib/addons';
import type { StreamOption, StreamTarget } from '../../lib/streams';
import type { Playability, PlayabilityReason } from '../../lib/streamPlayability';
import { Badge, Spinner, TextButton, cx } from '../ui';
import { t } from '../../lib/i18n';
import { targetKeyOf, useStreams } from './useStreams';

interface StreamListProps {
  addons: VideoAddon[];
  target: StreamTarget | null;
  onPlay: (s: StreamOption) => void;
  onOpenAddons: () => void;
}

function levelLabel(level: Playability): string {
  return level === 'ok' ? t('Toca') : level === 'maybe' ? t('Pode falhar') : t('Não toca');
}

function reasonText(r: PlayabilityReason): string {
  switch (r) {
    case 'not_web_ready':
      return t('O addon avisa que não é para navegador');
    case 'proxy_headers':
      return t('Exige cabeçalhos que o navegador não envia');
    case 'hevc':
      return t('Vídeo HEVC que este navegador não decodifica');
    case 'av1':
      return t('Vídeo AV1 que este navegador não decodifica');
    case 'dolby_vision':
      return t('Dolby Vision pode ficar sem cor');
    case 'audio':
      return t('Áudio que este navegador não decodifica');
    default:
      return t('Formato não identificado');
  }
}

const BADGE_TONE: Record<Playability, string> = {
  ok: 'text-lu-text',
  maybe: 'text-lu-muted',
  no: 'text-lu-muted opacity-70',
};

// Título e descrição vão como o addon mandou; a URL do stream nunca aparece
const StreamRow: React.FC<{ option: StreamOption; onPlay: (s: StreamOption) => void }> = ({ option, onPlay }) => (
  <li className="flex">
    <button
      type="button"
      onClick={() => onPlay(option)}
      className={cx(
        'w-full flex items-start justify-between gap-3 p-3.5 rounded-[12px] bg-lu-bg2 border border-lu-border text-left cursor-pointer transition-colors',
        'hover:bg-white/8 hover:border-lu-border-strong text-lu-text',
        option.level === 'no' && 'opacity-70',
      )}
    >
      <span className="flex flex-col min-w-0 flex-1 gap-1">
        <span className="text-[12px] text-lu-muted truncate">{option.sourceName}</span>
        {option.title && <span className="text-[14px] font-semibold whitespace-pre-line break-words">{option.title}</span>}
        {option.description && <span className="text-[12px] leading-relaxed text-lu-muted whitespace-pre-line break-words">{option.description}</span>}
      </span>
      <Badge className={cx('flex-none', BADGE_TONE[option.level])}>
        <span title={option.reasons.map(reasonText).join('\n') || undefined}>{levelLabel(option.level)}</span>
      </Badge>
    </button>
  </li>
);

/** "Onde assistir": streams dos addons da pessoa, do que toca melhor para o que toca pior. */
export const StreamList: React.FC<StreamListProps> = ({ addons, target, onPlay, onOpenAddons }) => {
  const { state, retry } = useStreams(addons, target);
  const [showRest, setShowRest] = useState(false);

  const targetKey = targetKeyOf(target);
  useEffect(() => setShowRest(false), [targetKey]);

  const playable = state.options.filter((o) => o.level !== 'no');
  const rest = state.options.filter((o) => o.level === 'no');
  const loading = state.status === 'loading';

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h3 className="m-0 flex-1 text-[16px] font-semibold">{t('Onde assistir')}</h3>
        {loading && <Spinner size={16} />}
        <TextButton size="sm" onClick={onOpenAddons}>
          {t('Addons')}
        </TextButton>
      </div>

      {addons.length === 0 ? (
        <TextButton tone="accent" className="self-start" onClick={onOpenAddons}>
          <Plus size={16} />
          {t('Adicionar um addon')}
        </TextButton>
      ) : (
        <>
          {playable.length > 0 && (
            <ul aria-label={t('Onde assistir')} className="m-0 p-0 list-none grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {playable.map((o) => (
                <StreamRow key={o.key} option={o} onPlay={onPlay} />
              ))}
            </ul>
          )}

          {rest.length > 0 &&
            (showRest ? (
              <ul className="m-0 p-0 list-none grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {rest.map((o) => (
                  <StreamRow key={o.key} option={o} onPlay={onPlay} />
                ))}
              </ul>
            ) : (
              <TextButton size="sm" className="self-start" aria-expanded={false} onClick={() => setShowRest(true)}>
                {t('Mostrar o resto ({n})', { n: rest.length })}
              </TextButton>
            ))}

          {state.status === 'done' && state.options.length === 0 && (
            <p className="m-0 text-[14px] text-lu-muted">{t('Nenhum stream encontrado')}</p>
          )}

          {state.failedSources > 0 && (
            <div className="flex items-center gap-2 text-[13px] text-lu-muted">
              <span>{state.failedSources === 1 ? t('1 addon falhou') : t('{n} addons falharam', { n: state.failedSources })}</span>
              <TextButton size="sm" tone="accent" onClick={retry}>
                {t('Tentar de novo')}
              </TextButton>
            </div>
          )}
        </>
      )}
    </section>
  );
};
