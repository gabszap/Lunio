import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cx, useDismiss } from '../ui';

export interface SelectOption {
  value: string;
  label: string;
}

/** Dropdown do Explorar: botão com o valor atual e uma lista escura, com um ponto no item escolhido (como o Descobrir do Stremio). */
export const Select: React.FC<{ label: string; value: string; options: SelectOption[]; onChange: (value: string) => void; className?: string }> = ({
  label,
  value,
  options,
  onChange,
  className,
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  useDismiss(open, () => setOpen(false), wrapRef);

  // Ao abrir, o item atual fica à vista e com o foco (setas e Enter funcionam a partir dele)
  useEffect(() => {
    if (!open) return;
    const current = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? listRef.current?.querySelector<HTMLElement>('[role="option"]');
    current?.focus();
    current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  const current = options.find((o) => o.value === value);
  const move = (e: React.KeyboardEvent, step: number) => {
    e.preventDefault();
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[Math.min(items.length - 1, Math.max(0, i + step))]?.focus();
  };

  return (
    <div ref={wrapRef} className={cx('relative', className)}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'inline-flex items-center justify-between gap-6 w-full h-12 px-5 rounded-full border border-lu-border bg-lu-surface text-lu-text text-[15px] font-medium cursor-pointer',
          'hover:bg-lu-elevated focus-visible:outline-2 focus-visible:outline-lu-accent',
          open && 'bg-lu-elevated'
        )}
      >
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronDown size={18} className={cx('flex-none text-lu-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') move(e, 1);
            else if (e.key === 'ArrowUp') move(e, -1);
          }}
          className="absolute left-0 top-full mt-2 z-50 min-w-full w-max max-w-[min(340px,90vw)] max-h-[min(360px,60vh)] overflow-y-auto custom-scrollbar p-2 rounded-2xl bg-lu-elevated border border-lu-border shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
        >
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setOpen(false);
                  if (!selected) onChange(o.value);
                }}
                className={cx(
                  'flex items-center justify-between gap-4 w-full h-11 px-4 rounded-xl text-left text-[15px] bg-transparent border-0 cursor-pointer',
                  'hover:bg-white/6 focus-visible:bg-white/8 focus-visible:outline-none',
                  selected ? 'text-lu-text font-semibold' : 'text-lu-text'
                )}
              >
                <span className="truncate">{o.label}</span>
                {selected && <span aria-hidden="true" className="flex-none w-2 h-2 rounded-full bg-lu-success" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
