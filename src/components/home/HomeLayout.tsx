import React from 'react';
import { Activity, Github, LayoutGrid, Users } from 'lucide-react';
import { Logo, PillTabs, cx } from '../ui';
import { LANGS, setLang, t, msg, useLang } from '../../lib/i18n';

export type HomeTab = 'catalog' | 'room' | 'status';

export const REPO_URL = 'https://github.com/gabszap/Lunio';

interface HomeLayoutProps {
  tab: HomeTab;
  onTabChange: (tab: HomeTab) => void;
  onLogo: () => void;
  children: React.ReactNode;
  /** Catálogo rola a página; os passos da Sala ficam centralizados na tela. */
  centered?: boolean;
}

const TABS: Array<{ value: HomeTab; label: string; icon: React.ReactNode }> = [
  { value: 'catalog', label: msg('Catálogo'), icon: <LayoutGrid size={18} /> },
  { value: 'room', label: msg('Sala'), icon: <Users size={18} /> },
  { value: 'status', label: msg('Status'), icon: <Activity size={18} /> },
];

/** Troca de idioma (PT/EN). Só na Home: o app inteiro remonta com o idioma novo. */
const LanguageSwitch: React.FC = () => {
  const lang = useLang();
  return (
    <div role="group" aria-label={t('Idioma')} className="inline-flex items-center rounded-[10px] border border-lu-border p-0.5 mr-1">
      {LANGS.map((l) => (
        <button
          key={l.code}
          type="button"
          lang={l.code}
          aria-pressed={lang === l.code}
          title={l.label}
          onClick={() => setLang(l.code)}
          className={cx(
            'h-9 min-w-10 px-2.5 rounded-lg text-[12px] font-semibold uppercase transition-colors',
            lang === l.code ? 'bg-lu-tint text-lu-accent' : 'text-lu-muted hover:bg-white/8'
          )}
        >
          {l.code}
        </button>
      ))}
    </div>
  );
};

export const HomeLayout: React.FC<HomeLayoutProps> = ({ tab, onTabChange, onLogo, children, centered }) => (
  <div className={cx('relative min-h-screen flex flex-col', tab === 'catalog' ? 'lu-catalog-bg' : 'lu-home-bg')}>
    <header className="relative z-10 grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_1fr] items-center gap-y-3 px-4 sm:px-8 pt-4 sm:pt-0 sm:h-20">
      <Logo onClick={onLogo} />

      <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto [&>div]:w-full sm:[&>div]:w-auto [&_button]:flex-1 sm:[&_button]:flex-none">
        <PillTabs label={t('Como começar')} value={tab} onChange={onTabChange} options={TABS} />
      </div>

      <div className="flex items-center justify-end gap-1 col-start-2 row-start-1 sm:col-start-3">
        <LanguageSwitch />
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          aria-label={t('Ver o código no GitHub')}
          title={t('Ver o código no GitHub')}
          className="inline-flex items-center justify-center w-11 h-11 rounded-[10px] text-lu-text hover:bg-white/8"
        >
          <Github size={20} />
        </a>
      </div>
    </header>

    <main
      className={cx(
        'relative flex-1 flex flex-col',
        centered ? 'items-center justify-center gap-7 px-4 sm:px-8 pt-6 pb-12' : 'px-4 sm:px-12 pt-6 pb-16'
      )}
    >
      {children}
    </main>
  </div>
);
