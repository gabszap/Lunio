import React, { useEffect, useId, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { t } from '../lib/i18n';

/** Rótulos de opção chegam como ReactNode: só texto passa pelo dicionário. */
const translateNode = (node: React.ReactNode) => (typeof node === 'string' ? t(node) : node);

/**
 * Primitivas visuais do design system Lunio (canvas "Lunio" no Claude Design).
 * Cada uma corresponde a um padrão recorrente nos artboards:
 * lu-ib (IconButton/TextButton), lu-primary, lu-ghost, lu-row, menus, campos e modais.
 */

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');
export { cx };

// ───────────────────────── Logo ─────────────────────────

export const LogoMark: React.FC<{ size?: number; className?: string }> = ({ size = 32, className }) => {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="-24 -24 48 48" aria-hidden="true" className={cx('flex-none block', className)}>
      <defs>
        <linearGradient id={`lu-logo-${id}`} gradientUnits="userSpaceOnUse" x1="-20" y1="-20" x2="20" y2="20">
          <stop offset="0" stopColor="#A78BFA" />
          <stop offset="0.55" stopColor="#7C3AED" />
          <stop offset="1" stopColor="#38BDF8" />
        </linearGradient>
      </defs>
      <path d="M10.19 -14.84 A18 18 0 1 0 10.19 14.84 A15 15 0 1 1 10.19 -14.84 Z" fill={`url(#lu-logo-${id})`} />
      <polygon
        points="5 -7.5 5 7.5 16 0"
        fill={`url(#lu-logo-${id})`}
        stroke={`url(#lu-logo-${id})`}
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export const Logo: React.FC<{ onClick?: () => void; size?: number }> = ({ onClick, size = 32 }) => {
  const content = (
    <>
      <LogoMark size={size} />
      <span className="text-[20px] font-semibold tracking-[-0.03em] leading-none text-lu-text">lunio</span>
    </>
  );
  if (!onClick) {
    return <div className="flex items-center gap-2.5 flex-none">{content}</div>;
  }
  return (
    <a
      href="/"
      aria-label={t('Lunio, início')}
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
      className="flex items-center gap-2.5 h-11 no-underline text-inherit rounded-[10px] flex-none"
    >
      {content}
    </a>
  );
};

// ───────────────────────── Buttons ─────────────────────────

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

// Sem justify/flex aqui: cada variante decide (evita conflito com flex-1 e justify-between)
const baseBtn = 'appearance-none inline-flex items-center font-[inherit] transition-colors disabled:cursor-not-allowed';

/** Botão quadrado só com ícone (lu-ib). `label` vira aria-label e title. */
export const IconButton: React.FC<
  ButtonProps & { label: string; active?: boolean; size?: 36 | 40 | 44; tone?: 'text' | 'muted' }
> = ({ label, active, size = 44, tone = 'text', className, children, ...rest }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    {...rest}
    className={cx(
      baseBtn,
      'relative rounded-[10px] justify-center flex-none',
      size === 44 ? 'w-11 h-11' : size === 40 ? 'w-10 h-10' : 'w-9 h-9',
      active
        ? 'bg-lu-tint text-lu-accent hover:bg-lu-accent/20'
        : cx('bg-transparent hover:bg-white/8', tone === 'muted' ? 'text-lu-muted' : 'text-lu-text'),
      'disabled:opacity-40',
      className
    )}
  >
    {children}
  </button>
);

/** Botão de texto discreto (lu-ib com rótulo): "Voltar", "Limpar", "Ou olhe o catálogo". */
export const TextButton: React.FC<ButtonProps & { tone?: 'muted' | 'accent' | 'text'; size?: 'md' | 'sm' }> = ({
  tone = 'muted',
  size = 'md',
  className,
  children,
  ...rest
}) => (
  <button
    type="button"
    {...rest}
    className={cx(
      baseBtn,
      'justify-center gap-1.5 rounded-[10px] bg-transparent hover:bg-white/8 disabled:opacity-40',
      size === 'md' ? 'h-11 px-3 text-[14px]' : 'h-9 px-2.5 text-[13px]',
      tone === 'accent' ? 'text-lu-accent font-semibold' : tone === 'text' ? 'text-lu-text font-medium' : 'text-lu-muted font-medium',
      className
    )}
  >
    {children}
  </button>
);

export const PrimaryButton: React.FC<ButtonProps & { size?: 'md' | 'lg'; block?: boolean }> = ({
  size = 'md',
  block,
  className,
  children,
  ...rest
}) => (
  <button
    type="button"
    {...rest}
    className={cx(
      baseBtn,
      'justify-center gap-2 px-5 rounded-[10px] bg-lu-accent text-lu-bg text-[14px] font-semibold hover:bg-lu-accent-hover',
      'disabled:opacity-45 disabled:hover:bg-lu-accent',
      size === 'lg' ? 'h-12' : 'h-11',
      block && 'w-full',
      className
    )}
  >
    {children}
  </button>
);

export const GhostButton: React.FC<ButtonProps & { size?: 'md' | 'lg'; block?: boolean }> = ({
  size = 'md',
  block,
  className,
  children,
  ...rest
}) => (
  <button
    type="button"
    {...rest}
    className={cx(
      baseBtn,
      'justify-center gap-2 px-4 rounded-[10px] bg-lu-surface border border-lu-border-strong text-lu-text text-[14px] font-medium hover:bg-lu-elevated',
      'disabled:opacity-45',
      size === 'lg' ? 'h-12' : 'h-11',
      block && 'w-full',
      className
    )}
  >
    {children}
  </button>
);

// ───────────────────────── Small pieces ─────────────────────────

export const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="inline-flex items-center justify-center min-w-7 h-[26px] px-2 box-border rounded-md bg-lu-elevated border border-lu-border shadow-[inset_0_-1px_0_rgba(0,0,0,0.35)] font-[inherit] text-[12px] font-medium text-lu-text">
    {children}
  </kbd>
);

export const Dot: React.FC<{ tone?: 'success' | 'warning' | 'error' | 'accent' | 'muted'; pulse?: boolean }> = ({
  tone = 'success',
  pulse,
}) => (
  <span
    aria-hidden="true"
    className={cx(
      'w-1.5 h-1.5 rounded-full flex-none',
      tone === 'success' && 'bg-lu-success',
      tone === 'warning' && 'bg-lu-warning',
      tone === 'error' && 'bg-lu-error',
      tone === 'accent' && 'bg-lu-accent',
      tone === 'muted' && 'bg-lu-disabled',
      pulse && 'animate-pulse'
    )}
  />
);

export const Badge: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <span
    className={cx(
      'px-2 py-1 rounded-md bg-lu-surface/70 border border-lu-border text-[12px] font-medium text-lu-text whitespace-nowrap',
      className
    )}
  >
    {children}
  </span>
);

/** Bolha de ícone usada nos cards de fonte e títulos de seção (40×40, surface-elevated, ícone accent). */
export const IconTile: React.FC<{ children: React.ReactNode; size?: 36 | 40 }> = ({ children, size = 40 }) => (
  <span
    className={cx(
      'rounded-[10px] bg-lu-elevated text-lu-accent flex items-center justify-center flex-none',
      size === 40 ? 'w-10 h-10' : 'w-9 h-9'
    )}
  >
    {children}
  </span>
);

export const Spinner: React.FC<{ size?: number; className?: string }> = ({ size = 18, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={cx('flex-none animate-lu-spin', className)}
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

// ───────────────────────── Segmented control ─────────────────────────

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  label,
}: {
  value: T;
  onChange: (v: NoInfer<T>) => void;
  options: Array<{ value: NoInfer<T>; label: React.ReactNode; icon?: React.ReactNode }>;
  size?: 'sm' | 'md';
  className?: string;
  label?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cx('flex gap-0.5 p-[3px] rounded-[10px] bg-lu-bg2', className)}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(opt.value)}
            className={cx(
              baseBtn,
              'flex-1 justify-center gap-2 rounded-lg text-[13px]',
              size === 'sm' ? 'h-[34px]' : 'h-[38px]',
              selected ? 'bg-lu-tint text-lu-accent font-semibold' : 'text-lu-muted font-medium hover:bg-white/6'
            )}
          >
            {opt.icon}
            {translateNode(opt.label)}
          </button>
        );
      })}
    </div>
  );
}

/** Abas em "pílula" do cabeçalho (Catálogo / Sala / Status) e filtros (Temporadas, Tudo/Filmes/Séries). */
export function PillTabs<T extends string>({
  value,
  onChange,
  options,
  size = 'lg',
  label,
}: {
  value: T;
  onChange: (v: NoInfer<T>) => void;
  options: Array<{ value: NoInfer<T>; label: React.ReactNode; icon?: React.ReactNode }>;
  size?: 'lg' | 'sm';
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cx(
        'flex gap-1 p-1 bg-lu-bg2 border border-lu-border',
        size === 'lg' ? 'rounded-[14px]' : 'rounded-xl'
      )}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(opt.value)}
            className={cx(
              baseBtn,
              'justify-center gap-2 font-semibold',
              size === 'lg' ? 'h-11 px-[18px] rounded-[10px] text-[14px]' : 'h-9 px-3.5 rounded-lg text-[13px]',
              selected ? 'bg-lu-tint text-lu-accent' : 'bg-transparent text-lu-muted hover:bg-white/8'
            )}
          >
            {opt.icon}
            <span>{translateNode(opt.label)}</span>
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────── Choice chips (Sincronia, Velocidade, Tamanho…) ─────────────────────────

export const Chip: React.FC<ButtonProps & { selected?: boolean; dense?: boolean }> = ({
  selected,
  dense,
  className,
  children,
  ...rest
}) => (
  <button
    type="button"
    aria-pressed={selected}
    {...rest}
    className={cx(
      baseBtn,
      'justify-center flex-1 basis-0 min-w-0 h-8 box-border rounded-md border text-[12px] tabular whitespace-nowrap',
      dense ? 'px-1' : 'px-2.5',
      selected
        ? 'bg-lu-tint border-lu-accent/40 text-lu-accent font-semibold'
        : 'bg-lu-bg2 border-lu-border text-lu-muted font-medium hover:bg-white/6',
      className
    )}
  >
    {children}
  </button>
);

export const ChipRow: React.FC<{ children: React.ReactNode; gap?: 'tight' | 'normal' }> = ({ children, gap = 'normal' }) => (
  <div className={cx('flex', gap === 'tight' ? 'gap-1' : 'gap-1.5')}>{children}</div>
);

// ───────────────────────── Popover menus do player ─────────────────────────

export const MenuPanel = React.forwardRef<
  HTMLDivElement,
  { title: string; meta?: React.ReactNode; className?: string; children: React.ReactNode; id?: string; onClose?: () => void }
>(({ title, meta, className, children, id, onClose }, ref) => (
  <div
    ref={ref}
    id={id}
    role="dialog"
    aria-label={title}
    onClick={(e) => e.stopPropagation()}
    className={cx(
      'absolute bottom-full mb-3 max-w-[calc(100vw-32px)] box-border p-2 rounded-[14px] bg-lu-elevated border border-lu-border shadow-[0_16px_40px_rgba(0,0,0,0.5)] text-lu-text z-50',
      'max-h-[min(70vh,560px)] overflow-y-auto custom-scrollbar',
      className,
      // No celular os menus viram bottom sheets (Mobile · Player: legendas/áudio/ajustes)
      'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:mb-0 max-sm:w-auto max-sm:max-w-none max-sm:translate-x-0 max-sm:rounded-b-none max-sm:max-h-[80vh] max-sm:px-3 max-sm:pb-6 max-sm:z-[60]'
    )}
  >
    <div className="flex items-baseline justify-between px-2.5 pt-2 pb-2.5 max-sm:items-center max-sm:pt-3">
      <span className="text-[14px] font-semibold max-sm:text-[18px]">{title}</span>
      {meta !== undefined && <span className="text-[12px] text-lu-muted max-sm:hidden">{meta}</span>}
      {onClose && (
        <button
          type="button"
          aria-label={t('Fechar')}
          onClick={onClose}
          className="sm:hidden inline-flex items-center justify-center w-11 h-11 -mr-2 rounded-[10px] text-lu-muted hover:bg-white/8"
        >
          <X size={20} strokeWidth={1.75} />
        </button>
      )}
    </div>
    {children}
  </div>
));
MenuPanel.displayName = 'MenuPanel';

export const MenuItem: React.FC<{
  selected?: boolean;
  onClick: () => void;
  label: React.ReactNode;
  hint?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  tall?: boolean;
}> = ({ selected, onClick, label, hint, leading, trailing, tall }) => (
  <button
    type="button"
    role="menuitemradio"
    aria-checked={!!selected}
    onClick={onClick}
    className={cx(
      baseBtn,
      'w-full px-2.5 box-border rounded-[10px] justify-between gap-3 text-[14px] text-left',
      tall ? 'h-11' : 'h-10',
      selected ? 'bg-lu-tint text-lu-accent font-medium' : 'bg-transparent text-lu-text font-normal hover:bg-white/6'
    )}
  >
    <span className={cx('flex min-w-0', leading ? 'items-center gap-3' : 'items-baseline')}>
      {leading}
      <span className="truncate">{label}</span>
      {hint && <span className="text-[12px] text-lu-muted ml-2 flex-none">{hint}</span>}
    </span>
    <span className="flex items-center gap-2.5 flex-none">
      {trailing}
      {selected ? <Check size={16} strokeWidth={1.75} /> : trailing !== undefined ? <span className="w-4" /> : null}
    </span>
  </button>
);

export const MenuDivider: React.FC = () => <div className="h-px bg-lu-border mx-2.5 my-3" />;

export const MenuSection: React.FC<{
  title: string;
  value?: React.ReactNode;
  description?: string;
  children?: React.ReactNode;
  last?: boolean;
}> = ({ title, value, description, children, last }) => (
  <div className={cx('px-2.5', last && 'pb-1.5')}>
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[13px] font-medium">{title}</span>
      {value !== undefined && <span className="text-[13px] font-semibold tabular text-lu-accent">{value}</span>}
    </div>
    {description && <div className="text-[12px] text-lu-muted mt-0.5">{description}</div>}
    {children && <div className="mt-2.5">{children}</div>}
  </div>
);

export const Slider: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({ className, ...rest }) => (
  <input type="range" {...rest} className={cx('w-full m-0 mb-2 cursor-pointer', className)} />
);

/** Fecha um popover ao clicar fora ou apertar Esc. */
export function useDismiss(open: boolean, onClose: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, ref]);
}

// ───────────────────────── Form fields ─────────────────────────

export const FieldLabel: React.FC<{ htmlFor?: string; children: React.ReactNode; className?: string }> = ({
  htmlFor,
  children,
  className,
}) => (
  <label htmlFor={htmlFor} className={cx('block text-[13px] font-semibold mb-2', className)}>
    {children}
  </label>
);

export const Hint: React.FC<{ children: React.ReactNode; tone?: 'muted' | 'success' | 'error'; className?: string; id?: string; role?: string }> = ({
  children,
  tone = 'muted',
  className,
  id,
  role,
}) => (
  <p
    id={id}
    role={role}
    className={cx(
      'mt-2 mb-0 text-[12px] flex items-center gap-1.5',
      tone === 'success' ? 'text-lu-success' : tone === 'error' ? 'text-lu-error' : 'text-lu-muted',
      className
    )}
  >
    {children}
  </p>
);

/** Campo grande (52px) com ícone à esquerda e ações à direita — usado em todos os passos da Home. */
export const BigInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & {
    icon?: React.ReactNode;
    trailing?: React.ReactNode;
    invalid?: boolean;
    code?: boolean;
    wrapperClassName?: string;
  }
>(({ icon, trailing, invalid, code, wrapperClassName, className, ...rest }, ref) => (
  <div
    className={cx(
      'group flex items-center gap-2.5 h-[52px] pl-4 pr-2 rounded-xl bg-lu-bg border transition-shadow',
      invalid
        ? 'border-lu-error shadow-[0_0_0_3px_rgba(251,113,133,0.16)]'
        : 'border-lu-border-strong focus-within:border-lu-accent focus-within:shadow-[0_0_0_3px_var(--color-lu-tint)]',
      wrapperClassName
    )}
  >
    {icon && <span className={cx('flex', invalid ? 'text-lu-error' : 'text-lu-muted')}>{icon}</span>}
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      {...rest}
      className={cx(
        'flex-1 min-w-0 h-11 border-0 outline-0 bg-transparent text-lu-text font-[inherit] focus-visible:outline-none',
        code ? 'text-[16px] font-semibold tracking-[0.12em] tabular uppercase' : 'text-[15px]',
        className
      )}
    />
    {trailing}
  </div>
));
BigInput.displayName = 'BigInput';

export const TextInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => (
    <input
      ref={ref}
      type="text"
      {...rest}
      className={cx(
        'w-full h-11 box-border px-3.5 rounded-[10px] bg-lu-bg2 border border-lu-border text-lu-text font-[inherit] text-[14px]',
        'focus:border-lu-accent/50 focus-visible:outline-none',
        className
      )}
    />
  )
);
TextInput.displayName = 'TextInput';

export const ClearButton: React.FC<{ onClick: () => void; label?: string }> = ({ onClick, label = 'Limpar' }) => (
  <button
    type="button"
    aria-label={label}
    onClick={onClick}
    className={cx(baseBtn, 'justify-center flex-none w-10 h-10 rounded-lg text-lu-muted hover:bg-white/8')}
  >
    <X size={16} strokeWidth={1.75} />
  </button>
);

// ───────────────────────── Modal ─────────────────────────

export const Modal: React.FC<{
  open: boolean;
  onClose?: () => void;
  label: string;
  width?: number;
  alert?: boolean;
  children: React.ReactNode;
  className?: string;
}> = ({ open, onClose, label, width = 480, alert, children, className }) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = dialogRef.current?.querySelector<HTMLElement>(
      'input:not([disabled]), button:not([disabled]), [href], select, textarea'
    );
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-[rgba(3,4,7,0.92)]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-label={label}
        style={{ width }}
        className={cx(
          'max-w-full max-h-[calc(100vh-32px)] overflow-y-auto box-border p-7 rounded-[18px] bg-lu-surface border border-lu-border shadow-[0_24px_64px_rgba(0,0,0,0.55)] flex flex-col gap-5 text-lu-text',
          className
        )}
      >
        {children}
      </div>
    </div>
  );
};

export const ModalHeader: React.FC<{ title: string; description?: React.ReactNode; onClose?: () => void }> = ({
  title,
  description,
  onClose,
}) => (
  <div className="flex items-start justify-between gap-4">
    <div>
      <h2 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">{title}</h2>
      {description && <p className="mt-1.5 mb-0 text-[14px] text-lu-muted">{description}</p>}
    </div>
    {onClose && (
      <IconButton label={t('Fechar')} size={40} tone="muted" onClick={onClose} className="-mt-1.5 -mr-2">
        <X size={18} strokeWidth={1.75} />
      </IconButton>
    )}
  </div>
);

// ───────────────────────── Cards da Home ─────────────────────────

export const HomeCard: React.FC<{ children: React.ReactNode; wide?: boolean; className?: string; center?: boolean }> = ({
  children,
  wide,
  className,
  center,
}) => (
  <section
    className={cx(
      'w-full box-border p-5 sm:p-7 rounded-[20px] bg-lu-surface border border-lu-border shadow-[0_24px_64px_rgba(0,0,0,0.45)]',
      wide ? 'max-w-[600px]' : 'max-w-[560px]',
      center && 'text-center flex flex-col items-center',
      className
    )}
  >
    {children}
  </section>
);

export const HomeCardTitle: React.FC<{ icon?: React.ReactNode; title: string; description?: React.ReactNode }> = ({
  icon,
  title,
  description,
}) => (
  <>
    <div className="flex items-center gap-3 mb-1.5">
      {icon && <IconTile>{icon}</IconTile>}
      <h1 className="m-0 text-[22px] sm:text-[24px] font-semibold tracking-[-0.02em] leading-tight">{title}</h1>
    </div>
    {description && <p className="mt-1.5 mb-5 text-[14px] text-lu-muted">{description}</p>}
  </>
);

/** Linha final com "Voltar" à esquerda e ações à direita. */
export const CardFooter: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div className={cx('flex items-center justify-between gap-3 mt-6 flex-wrap', className)}>{children}</div>
);

export const Avatar: React.FC<{ name: string; url?: string; size?: 32 | 36 }> = ({ name, url, size = 36 }) =>
  url ? (
    <img
      src={url}
      alt=""
      className={cx('flex-none rounded-full object-cover border border-lu-border', size === 36 ? 'w-9 h-9' : 'w-8 h-8')}
    />
  ) : (
    <div
      aria-hidden="true"
      className={cx(
        'flex-none rounded-full bg-lu-elevated border border-lu-border flex items-center justify-center text-[12px] font-semibold text-lu-text',
        size === 36 ? 'w-9 h-9' : 'w-8 h-8'
      )}
    >
      {name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?'}
    </div>
  );
