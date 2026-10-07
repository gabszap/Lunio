import React from 'react';
import { ArrowRight, Captions, FolderOpen, Link, LogIn, Magnet, MonitorUp, RefreshCw, Upload, Users, Youtube } from 'lucide-react';
import { GhostButton, HomeCard, TextButton, cx } from '../ui';
import { t, msg } from '../../lib/i18n';

export type SourceStep = 'upload' | 'torrent' | 'youtube' | 'drive' | 'screen' | 'stream';

interface SourceOption {
  step: SourceStep;
  title: string;
  hint: string;
  icon: React.ReactNode;
  /** Ainda sem motor no servidor: aparece desativado com selo "Em breve". */
  soon?: boolean;
}

const SOURCES: SourceOption[] = [
  { step: 'upload', title: msg('Enviar um arquivo'), hint: msg('MKV, MP4 e mais · até 50 GB'), icon: <Upload size={20} /> },
  { step: 'torrent', title: msg('Abrir torrent'), hint: msg('Cole um magnet link'), icon: <Magnet size={20} />, soon: true },
  { step: 'youtube', title: msg('Abrir vídeo do YouTube'), hint: msg('Vídeo ou live, pelo link'), icon: <Youtube size={20} /> },
  { step: 'drive', title: msg('Abrir o Google Drive'), hint: msg('Um vídeo do seu Drive, pelo link'), icon: <FolderOpen size={20} /> },
  { step: 'screen', title: msg('Compartilhar sua tela'), hint: msg('Sua tela vira a sala, ao vivo'), icon: <MonitorUp size={20} />, soon: true },
  { step: 'stream', title: msg('Colar link de stream'), hint: msg('Stremio, TorBox, .mkv ou debrid'), icon: <Link size={20} /> },
];

interface RoomMenuProps {
  onPick: (step: SourceStep) => void;
  onJoin: () => void;
  onCatalog: () => void;
}

export const RoomMenu: React.FC<RoomMenuProps> = ({ onPick, onJoin, onCatalog }) => (
  <>
    <HomeCard>
      <h1 className="m-0 text-[22px] sm:text-[24px] font-semibold tracking-[-0.02em] leading-tight">{t('Crie uma sala')}</h1>
      <p className="mt-1.5 mb-5 text-[14px] text-lu-muted">{t('Solte um vídeo e assista na hora com os amigos.')}</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {SOURCES.map((s) => (
          <button
            key={s.step}
            type="button"
            disabled={s.soon}
            onClick={() => onPick(s.step)}
            className={cx(
              'flex items-center justify-start gap-3.5 min-h-[76px] px-4 rounded-[14px] bg-lu-bg2 border border-lu-border text-left w-full transition-colors',
              s.soon ? 'cursor-not-allowed opacity-60' : 'hover:bg-white/6'
            )}
          >
            <span className="w-10 h-10 rounded-[10px] bg-lu-elevated text-lu-accent flex items-center justify-center flex-none">
              {s.icon}
            </span>
            <span className="flex flex-col gap-0.5 min-w-0">
              <span className="flex items-center gap-2 text-[14px] font-semibold text-lu-text">
                {t(s.title)}
                {s.soon && (
                  <span className="px-1.5 py-px rounded-md bg-lu-elevated text-[11px] font-medium text-lu-muted whitespace-nowrap">{t('Em breve')}</span>
                )}
              </span>
              <span className="text-[12px] text-lu-muted">{t(s.hint)}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 mt-5 pt-5 border-t border-lu-border flex-wrap">
        <GhostButton onClick={onJoin} className="!border-lu-border">
          <LogIn size={18} />
          <span>{t('Entrar na sala')}</span>
        </GhostButton>
        <TextButton tone="accent" onClick={onCatalog}>
          <span>{t('Ou olhe o catálogo')}</span>
          <ArrowRight size={16} />
        </TextButton>
      </div>
    </HomeCard>

    <div className="hidden sm:flex items-center justify-center gap-8 text-lu-muted">
      <span className="flex items-center gap-2 text-[13px]">
        <RefreshCw size={16} />
        {t('Sincronia em tempo real')}
      </span>
      <span className="flex items-center gap-2 text-[13px]">
        <Captions size={16} />
        {t('Chat e legendas')}
      </span>
      <span className="flex items-center gap-2 text-[13px]">
        <Users size={16} />
        {t('A tela de quem quiser')}
      </span>
    </div>
  </>
);
