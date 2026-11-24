import React, { useState } from 'react';
import { Activity, Github, Globe, Home, LayoutGrid } from 'lucide-react';
import { Logo, cx, useSlidingPill } from '../ui';
import { LANGS, setLang, t, msg, useLang } from '../../lib/i18n';

export type HomeTab = 'catalog' | 'room' | 'status';

const TAB_ORDER: Record<HomeTab, number> = { room: 0, catalog: 1, status: 2 };

export const REPO_URL = 'https://github.com/gabszap/Lunio';

/** Versão do site: hash do commit do build ("dev" fora de um repositório git). */
export const COMMIT = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev';

interface HomeLayoutProps {
  tab: HomeTab;
  /** Sub-etapa dentro da aba (ex.: 'entry' -> 'stream') para animar avançar/voltar. */
  stepKey?: string;
  onTabChange: (tab: HomeTab) => void;
  onLogo: () => void;
  children: React.ReactNode;
  /** Catálogo rola a página; os passos da Sala ficam centralizados na tela. */
  centered?: boolean;
}

type NavItem =
  | { kind: 'tab'; value: HomeTab; label: string; icon: React.ReactNode }
  | { kind: 'disabled'; id: string; label: string; badge: string; title: string; icon: React.ReactNode };

const NAV_ITEMS: NavItem[] = [
  { kind: 'tab', value: 'room', label: msg('Início'), icon: <Home size={16} strokeWidth={1.85} aria-hidden="true" /> },
  {
    kind: 'disabled',
    id: 'rooms',
    label: msg('Salas'),
    badge: msg('Em breve'),
    title: msg('Listagem de salas públicas em breve'),
    icon: <Globe size={16} strokeWidth={1.85} aria-hidden="true" />,
  },
  { kind: 'tab', value: 'catalog', label: msg('Catálogo'), icon: <LayoutGrid size={16} strokeWidth={1.85} aria-hidden="true" /> },
  { kind: 'tab', value: 'status', label: msg('Status'), icon: <Activity size={16} strokeWidth={1.85} aria-hidden="true" /> },
];

/** Troca de idioma (PT/EN). Só na Home: o app inteiro remonta com o idioma novo. */
const LanguageSwitch: React.FC = () => {
  const lang = useLang();
  return (
    <div
      role="group"
      aria-label={t('Idioma')}
      className="inline-flex items-center rounded-full bg-lu-bg2/90 backdrop-blur-md border border-lu-border p-1"
    >
      {LANGS.map((l) => (
        <button
          key={l.code}
          type="button"
          lang={l.code}
          aria-pressed={lang === l.code}
          title={l.label}
          onClick={() => setLang(l.code)}
          className={cx(
            'h-8 min-w-9 px-2.5 rounded-full text-[12px] font-semibold uppercase transition-colors',
            lang === l.code ? 'bg-lu-tint text-lu-accent' : 'text-lu-muted hover:text-lu-text hover:bg-white/6'
          )}
        >
          {l.code}
        </button>
      ))}
    </div>
  );
};

export const HomeLayout: React.FC<HomeLayoutProps> = ({ tab, stepKey, onTabChange, onLogo, children, centered }) => {
  const lang = useLang();
  const { listRef, clipPath, animated, setButtonRef } = useSlidingPill(tab, 9999, lang);

  const [nav, setNav] = useState<{ tab: HomeTab; stepKey?: string; dir: 'right' | 'left' | null }>({
    tab,
    stepKey,
    dir: null,
  });
  if (nav.tab !== tab) {
    setNav({ tab, stepKey, dir: TAB_ORDER[tab] >= TAB_ORDER[nav.tab] ? 'right' : 'left' });
  } else if (nav.stepKey !== stepKey) {
    setNav({ tab, stepKey, dir: stepKey === 'entry' ? 'left' : 'right' });
  }
  const panelAnimClass =
    nav.dir === 'right'
      ? 'lu-tab-panel-right'
      : nav.dir === 'left'
      ? 'lu-tab-panel-left'
      : undefined;

  return (
  <div className={cx('relative min-h-screen flex flex-col overflow-x-clip', tab === 'catalog' ? 'lu-catalog-bg' : 'lu-home-bg')}>
    <header className="relative z-10 grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_1fr] items-center gap-y-3 px-4 sm:px-8 pt-4 sm:pt-0 sm:h-20">
      <Logo onClick={onLogo} />

      <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto overflow-x-auto no-scrollbar max-w-full">
        <div
          ref={listRef}
          role="tablist"
          aria-label={t('Navegação principal')}
          className="relative mx-auto flex w-max items-center gap-1 rounded-full bg-lu-bg2/90 backdrop-blur-md border border-lu-border p-1.5"
        >
          {clipPath && (
            <span
              aria-hidden="true"
              className={cx('lu-pill-indicator', animated && 'lu-pill-indicator-animated')}
              style={{ clipPath }}
            />
          )}
          {NAV_ITEMS.map((item) => {
            if (item.kind === 'disabled') {
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled
                  title={t(item.title)}
                  className="relative z-10 appearance-none inline-flex items-center justify-center gap-1.5 h-9 sm:h-10 px-3.5 sm:px-4 rounded-full bg-transparent text-[13.5px] sm:text-[14px] font-medium text-lu-disabled whitespace-nowrap cursor-not-allowed select-none"
                >
                  {item.icon}
                  <span>{t(item.label)}</span>
                  <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-lu-surface border border-lu-border text-[10px] font-semibold leading-none tracking-[0.02em] text-lu-muted">
                    {t(item.badge)}
                  </span>
                </button>
              );
            }
            const selected = item.value === tab;
            return (
              <button
                key={item.value}
                ref={setButtonRef(item.value)}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onTabChange(item.value)}
                className={cx(
                  'lu-pill-btn relative z-10 appearance-none inline-flex items-center justify-center gap-2 h-9 sm:h-10 px-3.5 sm:px-4 rounded-full font-[inherit] text-[13.5px] sm:text-[14px] font-semibold whitespace-nowrap',
                  selected ? cx('text-lu-accent', !clipPath && 'bg-lu-tint') : 'bg-transparent text-lu-muted'
                )}
              >
                {item.icon}
                <span>{t(item.label)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-end gap-1.5 col-start-2 row-start-1 sm:col-start-3">
        <LanguageSwitch />
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          aria-label={t('Ver o código no GitHub')}
          title={t('Ver o código no GitHub')}
          className="inline-flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-lu-bg2/90 backdrop-blur-md border border-lu-border text-lu-text hover:bg-lu-surface hover:border-lu-border-strong transition-colors"
        >
          <Github size={18} />
        </a>
        <a
          href={COMMIT === 'dev' ? REPO_URL : `${REPO_URL}/commit/${COMMIT}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center h-9 sm:h-10 px-2.5 sm:px-3 rounded-full bg-lu-bg2/90 backdrop-blur-md border border-lu-border text-[12px] font-mono tabular text-lu-muted hover:text-lu-text hover:bg-lu-surface hover:border-lu-border-strong transition-colors"
        >
          {COMMIT}
        </a>
      </div>
    </header>

    <main
      key={`${tab}:${stepKey ?? ''}`}
      className={cx(
        'relative flex-1 flex flex-col',
        centered ? 'items-center justify-start sm:justify-center gap-6 px-4 sm:px-8 pt-8 sm:pt-10 pb-16' : 'px-4 sm:px-12 pt-6 pb-16',
        panelAnimClass
      )}
    >
      {children}
    </main>
  </div>
  );
};
