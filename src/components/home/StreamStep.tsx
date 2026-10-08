import React, { useMemo, useState } from 'react';
import { parseTorrentTitle } from '@viren070/parse-torrent-title';
import { ChevronDown, ChevronLeft, CircleCheck, Clipboard, History, Link, Captions, Users, Play, X, CircleAlert } from 'lucide-react';
import { detectMimeType, validateAndFormatUrl, getYouTubeId } from '../../lib/media';
import { RecentStream, extractCleanTitleFromUrl, formatRecentTitle } from '../../lib/recent';
import { logger } from '../../lib/logger';
import { BigInput, CardFooter, FieldLabel, GhostButton, Hint, HomeCard, HomeCardTitle, PrimaryButton, TextButton } from '../ui';
import type { CommitMode, SourceCommit } from './types';
import { t } from '../../lib/i18n';

const FORMATS = [
  { value: 'video/x-matroska', label: 'MKV (Remux)' },
  { value: 'video/mp4', label: 'MP4' },
  { value: 'video/webm', label: 'WebM' },
  { value: 'application/x-mpegurl', label: 'HLS (.m3u8)' },
];

interface StreamStepProps {
  recentStreams: RecentStream[];
  onRemoveRecent: (url: string) => void;
  onClearRecent: () => void;
  /** Título vindo do catálogo ("Série · S01E02"). */
  intentTitle?: string;
  preferSolo?: boolean;
  pendingSubtitles: number;
  onAddSubtitle: () => void;
  onBack: () => void;
  onCommit: SourceCommit;
}

export const StreamStep: React.FC<StreamStepProps> = ({
  recentStreams,
  onRemoveRecent,
  onClearRecent,
  intentTitle,
  preferSolo,
  pendingSubtitles,
  onAddSubtitle,
  onBack,
  onCommit,
}) => {
  const [url, setUrl] = useState('');
  const [mime, setMime] = useState<string | null>(null);
  const [error, setError] = useState('');

  const formatted = validateAndFormatUrl(url);
  const isHttp = /^https?:\/\//i.test(formatted);
  const autoMime = useMemo(() => (formatted ? detectMimeType(formatted) : 'video/x-matroska'), [formatted]);
  const effectiveMime = mime ?? autoMime;

  const info = useMemo(() => {
    if (!isHttp) return null;
    const name = extractCleanTitleFromUrl(formatted);
    let parsed: any = null;
    try {
      parsed = name ? parseTorrentTitle(name) : null;
    } catch {
      parsed = null;
    }
    const bits = [parsed?.resolution, parsed?.codec?.toUpperCase?.()].filter(Boolean);
    return { name, bits };
  }, [formatted, isHttp]);

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && /^https?:\/\//i.test(text.trim())) {
        setUrl(text.trim());
        setError('');
        logger.action('[Mídia] Link colado da área de transferência');
      } else {
        setError(t('Nenhum link http(s) na área de transferência.'));
      }
    } catch {
      setError(t('O navegador não deixou ler a área de transferência. Cole com Ctrl+V.'));
    }
  };

  const commit = (mode: CommitMode, targetUrl = formatted, recentTitle?: string) => {
    if (!/^https?:\/\//i.test(targetUrl)) {
      setError(t('Cole uma URL completa, começando com http:// ou https://'));
      return;
    }
    if (getYouTubeId(targetUrl)) {
      setError(t('Isso é um link do YouTube. Volte e use "Abrir vídeo do YouTube".'));
      return;
    }
    const title = recentTitle || intentTitle || extractCleanTitleFromUrl(targetUrl) || 'Stream';
    onCommit(
      {
        url: targetUrl,
        mimeType: recentTitle ? detectMimeType(targetUrl) : effectiveMime,
        title,
        chapters: [],
        subtitles: [],
        audioTracks: [],
        isMkv: /\.mkv|torrentio/i.test(targetUrl),
      },
      mode,
      { recent: true }
    );
  };

  const primaryMode: CommitMode = preferSolo ? 'solo' : 'room';

  return (
    <HomeCard wide>
      <HomeCardTitle
        icon={<Link size={20} />}
        title={t('Colar link de stream')}
        description={
          intentTitle ? (
            <>
              {t('Para')} <strong className="text-lu-text font-semibold">{intentTitle}</strong>{t(': cole a URL direta do Stremio, TorBox, debrid ou de um .mkv.')}
            </>
          ) : (
            t('URL direta do Stremio, TorBox, debrid ou de um arquivo .mkv.')
          )
        }
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          commit(primaryMode);
        }}
      >
        <FieldLabel htmlFor="st-url">{t('URL do stream')}</FieldLabel>
        <div className="flex flex-col sm:flex-row gap-2">
          <BigInput
            id="st-url"
            type="url"
            inputMode="url"
            autoFocus
            placeholder={t('https://…/Nome.da.Serie.S01E02.mkv')}
            value={url}
            invalid={Boolean(error)}
            aria-describedby="st-msg"
            onChange={(e) => {
              setUrl(e.target.value);
              setError('');
            }}
            wrapperClassName="flex-1 min-w-0"
            trailing={
              <TextButton size="sm" onClick={handlePaste} className="!h-10">
                <Clipboard size={16} />
                <span>{t('Colar')}</span>
              </TextButton>
            }
          />
          <div className="relative flex-none sm:w-[150px]">
            <select
              aria-label={t('Formato do vídeo')}
              value={effectiveMime}
              onChange={(e) => setMime(e.target.value)}
              className="appearance-none w-full h-[52px] box-border pl-3.5 pr-9 rounded-xl bg-lu-bg border border-lu-border-strong text-lu-text font-[inherit] text-[14px]"
            >
              {FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <span className="absolute right-3 inset-y-0 flex items-center pointer-events-none text-lu-muted">
              <ChevronDown size={16} />
            </span>
          </div>
        </div>

        {error ? (
          <Hint id="st-msg" role="alert" tone="error">
            <CircleAlert size={14} />
            {error}
          </Hint>
        ) : info ? (
          <Hint id="st-msg" tone="success">
            <CircleCheck size={14} />
            {t('Link válido')}
            {info.bits.length ? ` · ${info.bits.join(' · ')}` : ''}
            {info.name ? ` · ${info.name}` : ''}
          </Hint>
        ) : null}

        {recentStreams.length > 0 && (
          <>
            <div className="flex items-center justify-between mt-5 mb-2">
              <span className="flex items-center gap-1.5 text-[13px] font-semibold">
                <History size={16} />
                {t('Recentes')}
              </span>
              <TextButton size="sm" onClick={onClearRecent} className="!h-8 text-[12px]">
                {t('Limpar')}
              </TextButton>
            </div>
            <ul className="list-none m-0 p-0 flex flex-col gap-1.5 max-h-[188px] overflow-y-auto custom-scrollbar">
              {recentStreams.map((item) => {
                const { epTag, cleanName } = formatRecentTitle(item.title);
                return (
                  <li key={item.url} className="flex items-center h-11 rounded-[10px] bg-lu-bg2 border border-lu-border hover:bg-white/6">
                    <button
                      type="button"
                      title={`${item.title}\n${item.url}`}
                      onClick={() => commit(primaryMode, item.url, item.title)}
                      className="flex-1 min-w-0 h-full flex items-center gap-3 pl-3.5 text-left"
                    >
                      <span className="w-14 flex-none text-[11px] font-semibold tracking-[0.03em] text-lu-accent">{epTag}</span>
                      <span className="flex-1 min-w-0 truncate text-[14px] text-lu-muted">{cleanName}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={t('Remover {cleanName} do histórico', { cleanName })}
                      onClick={() => onRemoveRecent(item.url)}
                      className="w-9 h-9 mr-1 flex-none rounded-lg inline-flex items-center justify-center text-lu-disabled hover:bg-white/8 hover:text-lu-text"
                    >
                      <X size={16} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <CardFooter>
          <TextButton onClick={onBack} className="!pl-2">
            <ChevronLeft size={18} />
            <span>{t('Voltar')}</span>
          </TextButton>
          <div className="flex flex-wrap gap-2 justify-end">
            <GhostButton onClick={onAddSubtitle}>
              <Captions size={18} />
              <span>{t('Legenda')}{pendingSubtitles > 0 ? ` (${pendingSubtitles})` : ''}</span>
            </GhostButton>
            {primaryMode === 'room' ? (
              <>
                <GhostButton onClick={() => commit('solo')}>
                  <Play size={16} />
                  <span>{t('Assistir sozinho')}</span>
                </GhostButton>
                <PrimaryButton type="submit">
                  <Users size={18} />
                  <span>{t('Criar sala')}</span>
                </PrimaryButton>
              </>
            ) : (
              <>
                <GhostButton onClick={() => commit('room')}>
                  <Users size={18} />
                  <span>{t('Criar sala')}</span>
                </GhostButton>
                <PrimaryButton type="submit">
                  <Play size={16} />
                  <span>{t('Assistir sozinho')}</span>
                </PrimaryButton>
              </>
            )}
          </div>
        </CardFooter>
      </form>
    </HomeCard>
  );
};
