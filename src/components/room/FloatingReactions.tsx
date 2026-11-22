import React, { useEffect, useState } from 'react';
import { Droplets, Flame, Hand, Heart, Laugh, Zap } from 'lucide-react';
import { t, msg } from '../../lib/i18n';
import { syncManager } from '../../lib/sync';
import type { ReactionKind, RoomReaction } from '../../types/sync';
import { cx } from '../ui';

export const REACTION_ITEMS: Array<{
  kind: ReactionKind;
  label: string;
  icon: React.FC<{ size?: number; className?: string }>;
  tone: string;
}> = [
  { kind: 'fire', label: msg('Fogo'), icon: Flame, tone: 'text-orange-400' },
  { kind: 'laugh', label: msg('Risada'), icon: Laugh, tone: 'text-amber-300' },
  { kind: 'shock', label: msg('Choque'), icon: Zap, tone: 'text-sky-300' },
  { kind: 'heart', label: msg('Coração'), icon: Heart, tone: 'text-rose-400' },
  { kind: 'clap', label: msg('Palmas'), icon: Hand, tone: 'text-emerald-400' },
  { kind: 'cry', label: msg('Choro'), icon: Droplets, tone: 'text-blue-400' },
];

const REACTION_MAP = new Map(REACTION_ITEMS.map((item) => [item.kind, item]));

interface ActiveBubble extends RoomReaction {
  offsetPct: number;
}

/**
 * Reações flutuantes discretas sobre o canto direito do palco (sem bloquear cliques nem atrapalhar legendas).
 */
export const FloatingReactions: React.FC = () => {
  const [bubbles, setBubbles] = useState<ActiveBubble[]>([]);

  useEffect(() => {
    const timers = new Set<number>();
    const unsub = syncManager.subscribeReaction((reaction) => {
      const offsetPct = 8 + Math.floor(Math.random() * 56);
      setBubbles((prev) => [...prev.slice(-11), { ...reaction, offsetPct }]);
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        setBubbles((prev) => prev.filter((b) => b.id !== reaction.id));
      }, 2400);
      timers.add(timer);
    });
    return () => {
      unsub();
      for (const id of timers) window.clearTimeout(id);
    };
  }, []);

  if (bubbles.length === 0) return null;

  return (
    <div
      aria-live="off"
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-4 right-4 w-40 z-30 overflow-hidden"
    >
      {bubbles.map((b) => {
        const meta = REACTION_MAP.get(b.kind);
        if (!meta) return null;
        const Icon = meta.icon;
        return (
          <div
            key={b.id}
            style={{ right: `${b.offsetPct}px` }}
            className="lu-reaction-float absolute bottom-4 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-lu-bg2/90 backdrop-blur-md border border-lu-border-strong shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
          >
            <Icon size={16} className={cx('flex-none', meta.tone)} />
            <span className="text-[11px] font-semibold text-lu-text/90 max-w-[84px] truncate">{b.username}</span>
          </div>
        );
      })}
    </div>
  );
};

export function reactionLabel(kind: ReactionKind): string {
  const meta = REACTION_MAP.get(kind);
  return meta ? t(meta.label) : kind;
}
