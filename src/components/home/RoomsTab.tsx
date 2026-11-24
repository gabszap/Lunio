import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  Film,
  Globe,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  SearchX,
  SlidersHorizontal,
} from 'lucide-react';
import { ClearButton, Dot, GhostButton, IconTile, PrimaryButton, cx, useDismiss } from '../ui';
import { msg, t } from '../../lib/i18n';
import type { PublicRoomActivity, PublicRoomSummary } from '../../types/sync';
import { CompactAvatar, RoomBannerVisual, RoomDetailModal } from './RoomDetailModal';

type ActivityFilter = 'all' | 'live' | 'screen' | 'media';
type RoomSort = 'members' | 'newest' | 'oldest' | 'live_first';

interface RoomsApiResponse {
  rooms: PublicRoomSummary[];
  total: number;
}

const AUTO_REFRESH_MS = 15_000;

const ACTIVITY_OPTIONS: Array<{ value: ActivityFilter; label: string }> = [
  { value: 'all', label: msg('Todas as salas') },
  { value: 'live', label: msg('Ao vivo') },
  { value: 'screen', label: msg('Com tela transmitindo') },
  { value: 'media', label: msg('Assistindo vídeo') },
];

const SORT_OPTIONS: Array<{ value: RoomSort; label: string }> = [
  { value: 'members', label: msg('Mais pessoas') },
  { value: 'newest', label: msg('Mais recentes') },
  { value: 'oldest', label: msg('Mais antigas') },
  { value: 'live_first', label: msg('Ao vivo primeiro') },
];

const ACTIVITY_RANK: Record<PublicRoomActivity, number> = {
  screen: 2,
  media: 1,
  idle: 0,
};

function formatRoomAge(createdAt: number, now: number): string {
  const min = Math.max(0, Math.floor((now - createdAt) / 60_000));
  if (min < 1) return t('agora há pouco');
  if (min === 1) return t('há 1 minuto');
  if (min < 60) return t('há {n} minutos', { n: min });
  const hours = Math.floor(min / 60);
  if (hours === 1) return t('há 1 hora');
  if (hours < 24) return t('há {n} horas', { n: hours });
  const days = Math.floor(hours / 24);
  return days === 1 ? t('há 1 dia') : t('há {n} dias', { n: days });
}

function FilterSelect<T extends string>({
  value,
  onChange,
  options,
  label,
  icon,
  align = 'right',
}: {
  value: T;
  onChange: (next: NoInfer<T>) => void;
  options: Array<{ value: NoInfer<T>; label: string }>;
  label: string;
  icon?: React.ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useDismiss(open, () => setOpen(false), menuRef, triggerRef);

  const selected = options.find((opt) => opt.value === value) ?? options[0];

  return (
    <div className="relative flex-none">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          'appearance-none w-full md:w-auto h-11 px-3.5 rounded-xl bg-lu-bg2 border font-[inherit] text-[13.5px] font-medium text-lu-text inline-flex items-center justify-between gap-2.5 whitespace-nowrap transition-colors',
          open
            ? 'border-lu-accent/70 bg-lu-surface'
            : 'border-lu-border hover:border-lu-border-strong hover:bg-lu-surface/70'
        )}
      >
        <span className="inline-flex items-center gap-2 min-w-0">
          {icon && <span className="text-lu-muted flex-none inline-flex">{icon}</span>}
          <span className="truncate">{t(selected.label)}</span>
        </span>
        <ChevronDown
          size={15}
          aria-hidden="true"
          className={cx('text-lu-muted flex-none transition-transform duration-150', open && 'rotate-180 text-lu-accent')}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="listbox"
          aria-label={label}
          className={cx(
            'absolute top-full mt-2 min-w-[210px] p-1.5 rounded-xl bg-lu-elevated border border-lu-border shadow-[0_16px_40px_rgba(0,0,0,0.5)] z-30 flex flex-col gap-0.5',
            align === 'left' ? 'left-0 md:left-auto md:right-0' : 'right-0'
          )}
        >
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={cx(
                  'appearance-none w-full h-9 px-2.5 rounded-lg font-[inherit] text-[13.5px] text-left inline-flex items-center justify-between gap-3 transition-colors',
                  isSelected
                    ? 'bg-lu-tint text-lu-accent font-medium'
                    : 'bg-transparent text-lu-text font-normal hover:bg-white/6'
                )}
              >
                <span className="truncate">{t(opt.label)}</span>
                {isSelected && <Check size={15} className="text-lu-accent flex-none" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const RoomCardSkeleton: React.FC = () => (
  <div
    aria-hidden="true"
    className="flex flex-col overflow-hidden rounded-2xl bg-lu-surface border border-lu-border animate-pulse"
  >
    <div className="aspect-[16/9] w-full bg-lu-bg2" />
    <div className="p-4 flex flex-col gap-3">
      <div className="h-4 w-2/3 rounded-md bg-lu-elevated" />
      <div className="h-3 w-1/2 rounded-md bg-lu-bg2" />
      <div className="pt-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-lu-elevated" />
          <div className="h-3 w-20 rounded-md bg-lu-bg2" />
        </div>
        <div className="h-3 w-14 rounded-md bg-lu-bg2" />
      </div>
    </div>
  </div>
);

export const RoomsTab: React.FC<{
  onJoinRoom: (code: string) => void;
  onCreateRoom: () => void;
}> = ({ onJoinRoom, onCreateRoom }) => {
  const [rooms, setRooms] = useState<PublicRoomSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const [query, setQuery] = useState('');
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [sortBy, setSortBy] = useState<RoomSort>('members');

  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<PublicRoomSummary | null>(null);

  const reqIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const hasLoadedRef = useRef(false);

  const fetchRooms = useCallback(async (source: 'initial' | 'manual' | 'auto') => {
    const reqId = ++reqIdRef.current;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    if (source === 'manual') setRefreshing(true);

    try {
      const res = await fetch('/api/rooms', { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as RoomsApiResponse;
      if (!mountedRef.current || reqId !== reqIdRef.current) return;

      const list = Array.isArray(data.rooms) ? data.rooms : [];
      setRooms(list);
      setTotal(typeof data.total === 'number' ? data.total : list.length);
      setError(false);
      setLoading(false);
      setNow(Date.now());
      hasLoadedRef.current = true;
    } catch (err) {
      if (ctrl.signal.aborted || !mountedRef.current || reqId !== reqIdRef.current) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setLoading(false);
      if (source !== 'auto' || !hasLoadedRef.current) setError(true);
    } finally {
      if (mountedRef.current && reqId === reqIdRef.current) {
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void fetchRooms('initial');

    const interval = window.setInterval(() => {
      if (!document.hidden) void fetchRooms('auto');
    }, AUTO_REFRESH_MS);

    const onVisibility = () => {
      if (!document.hidden) void fetchRooms('auto');
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      abortRef.current?.abort();
    };
  }, [fetchRooms]);

  const filteredRooms = useMemo(() => {
    const q = query.trim().toLowerCase();

    const matches = rooms.filter((room) => {
      if (activityFilter === 'live' && !room.screenLive && !room.hasMedia) return false;
      if (activityFilter === 'screen' && room.activity !== 'screen') return false;
      if (activityFilter === 'media' && room.activity !== 'media') return false;

      if (!q) return true;
      const inName = room.name.toLowerCase().includes(q);
      const inMedia = room.mediaTitle ? room.mediaTitle.toLowerCase().includes(q) : false;
      const inHost = room.hostName.toLowerCase().includes(q);
      return inName || inMedia || inHost;
    });

    return matches.slice().sort((a, b) => {
      if (sortBy === 'newest') return b.createdAt - a.createdAt;
      if (sortBy === 'oldest') return a.createdAt - b.createdAt;
      if (sortBy === 'live_first') {
        const diff = ACTIVITY_RANK[b.activity] - ACTIVITY_RANK[a.activity];
        if (diff !== 0) return diff;
        if (b.membersCount !== a.membersCount) return b.membersCount - a.membersCount;
        return b.createdAt - a.createdAt;
      }
      if (b.membersCount !== a.membersCount) return b.membersCount - a.membersCount;
      return b.createdAt - a.createdAt;
    });
  }, [rooms, query, activityFilter, sortBy]);

  const liveSelected = useMemo(
    () => (selectedCode ? rooms.find((r) => r.code === selectedCode) ?? null : null),
    [rooms, selectedCode]
  );
  useEffect(() => {
    if (liveSelected) setSelectedSnapshot(liveSelected);
  }, [liveSelected]);
  const selectedRoom = selectedCode ? liveSelected ?? selectedSnapshot : null;

  const openRoom = (room: PublicRoomSummary) => {
    setSelectedCode(room.code);
    setSelectedSnapshot(room);
  };

  const closeRoom = () => {
    setSelectedCode(null);
    setSelectedSnapshot(null);
  };

  const handleJoinFromModal = (code: string) => {
    closeRoom();
    onJoinRoom(code);
  };

  const clearFilters = () => {
    setQuery('');
    setActivityFilter('all');
  };

  const hasFilters = query.trim().length > 0 || activityFilter !== 'all';

  return (
    <div className="w-full max-w-[1160px] mx-auto flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="m-0 text-[26px] sm:text-[30px] font-semibold tracking-[-0.02em] leading-tight text-lu-text">
            {t('Salas públicas')}
          </h1>
          {!loading && !(error && rooms.length === 0) && (
            <span className="text-[13.5px] font-medium text-lu-muted tabular whitespace-nowrap">
              {total === 1 ? t('1 sala') : t('{n} salas', { n: total })}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          <GhostButton
            onClick={() => void fetchRooms('manual')}
            disabled={refreshing}
            aria-label={t('Atualizar')}
          >
            <RefreshCw size={16} className={refreshing ? 'animate-lu-spin' : ''} aria-hidden="true" />
            <span className="hidden sm:inline">{t('Atualizar')}</span>
          </GhostButton>
          <PrimaryButton onClick={onCreateRoom}>
            <Plus size={17} aria-hidden="true" />
            <span>{t('Criar sala')}</span>
          </PrimaryButton>
        </div>
      </div>

      <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <div className="flex-1 h-11 rounded-xl bg-lu-bg2 border border-lu-border focus-within:border-lu-accent/70 focus-within:shadow-[0_0_0_3px_var(--color-lu-tint)] flex items-center gap-2.5 pl-3.5 pr-1 transition-colors">
          <Search size={16} className="text-lu-muted flex-none" aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Pesquisar sala por nome...')}
            aria-label={t('Pesquisar sala por nome...')}
            className="flex-1 min-w-0 h-full border-0 outline-0 bg-transparent text-[14px] text-lu-text font-[inherit] focus-visible:outline-none"
          />
          {query && <ClearButton onClick={() => setQuery('')} label={t('Limpar busca')} />}
        </div>

        <div className="grid grid-cols-2 md:flex items-center gap-2.5">
          <FilterSelect
            value={activityFilter}
            onChange={setActivityFilter}
            options={ACTIVITY_OPTIONS}
            label={t('Filtrar por atividade')}
            icon={<SlidersHorizontal size={14} aria-hidden="true" />}
            align="left"
          />
          <FilterSelect
            value={sortBy}
            onChange={setSortBy}
            options={SORT_OPTIONS}
            label={t('Ordenar por')}
            icon={<ArrowUpDown size={14} aria-hidden="true" />}
            align="right"
          />
        </div>
      </div>

      {error && rooms.length > 0 && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-lu-surface border border-lu-error/30 text-[13.5px] text-lu-text"
        >
          <span className="inline-flex items-center gap-2 text-lu-error">
            <CircleAlert size={16} className="flex-none" aria-hidden="true" />
            <span>{t('Não foi possível carregar as salas.')}</span>
          </span>
          <GhostButton onClick={() => void fetchRooms('manual')} className="!h-9 !px-3 !text-[13px]">
            {t('Tentar de novo')}
          </GhostButton>
        </div>
      )}

      {loading ? (
        <div role="status" aria-label={t('Carregando')} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <RoomCardSkeleton />
          <RoomCardSkeleton />
          <RoomCardSkeleton />
        </div>
      ) : error && rooms.length === 0 ? (
        <section className="rounded-2xl bg-lu-surface border border-lu-border px-6 py-12 flex flex-col items-center text-center gap-3">
          <IconTile>
            <CircleAlert size={20} className="text-lu-error" aria-hidden="true" />
          </IconTile>
          <p className="m-0 text-[16px] font-semibold text-lu-text">{t('Não foi possível carregar as salas.')}</p>
          <GhostButton onClick={() => void fetchRooms('manual')} className="mt-1">
            {t('Tentar de novo')}
          </GhostButton>
        </section>
      ) : rooms.length === 0 ? (
        <section className="rounded-2xl bg-lu-surface border border-lu-border px-6 py-14 flex flex-col items-center text-center gap-3">
          <IconTile>
            <Globe size={20} aria-hidden="true" />
          </IconTile>
          <p className="m-0 text-[17px] font-semibold text-lu-text">{t('Nenhuma sala pública aberta agora')}</p>
          <p className="m-0 text-[13.5px] text-lu-muted max-w-[380px]">
            {t('Crie a primeira sala pública e convide a galera para assistir junto.')}
          </p>
          <PrimaryButton onClick={onCreateRoom} className="mt-2">
            <Plus size={17} aria-hidden="true" />
            <span>{t('Criar sala')}</span>
          </PrimaryButton>
        </section>
      ) : filteredRooms.length === 0 ? (
        <section className="rounded-2xl bg-lu-surface border border-lu-border px-6 py-12 flex flex-col items-center text-center gap-3">
          <IconTile>
            <SearchX size={20} aria-hidden="true" />
          </IconTile>
          <p className="m-0 text-[16px] font-semibold text-lu-text">{t('Nenhuma sala encontrada')}</p>
          <p className="m-0 text-[13.5px] text-lu-muted">
            {t('Tente ajustar a busca ou os filtros selecionados.')}
          </p>
          {hasFilters && (
            <GhostButton onClick={clearFilters} className="mt-1">
              {t('Limpar filtros')}
            </GhostButton>
          )}
        </section>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredRooms.map((room) => {
            const extraCount = Math.max(0, room.membersCount - room.members.length);
            const namesText = `${room.members.map((m) => m.username).join(', ')}${extraCount > 0 ? ` +${extraCount}` : ''}`;

            return (
              <button
                key={room.code}
                type="button"
                onClick={() => openRoom(room)}
                className="group appearance-none flex flex-col overflow-hidden rounded-2xl bg-lu-surface border border-lu-border hover:border-lu-accent/40 shadow-[0_12px_32px_rgba(0,0,0,0.28)] hover:shadow-[0_18px_40px_rgba(0,0,0,0.42)] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 active:translate-y-0 text-left font-[inherit]"
              >
                <div className="relative aspect-[16/9] w-full overflow-hidden bg-lu-bg2 border-b border-lu-border">
                  <RoomBannerVisual
                    previewUrl={room.previewUrl}
                    activity={room.activity}
                    imageClassName="transition-transform duration-300 group-hover:scale-[1.03]"
                  />

                  <span className="absolute top-3 left-3 bg-lu-bg/80 backdrop-blur-sm border border-lu-border rounded-full px-2.5 py-1 text-[11.5px] font-semibold text-lu-text inline-flex items-center gap-1.5">
                    {room.activity === 'screen' ? (
                      <>
                        <Radio size={12} className="text-lu-error flex-none" aria-hidden="true" />
                        <span>{t('Ao vivo')}</span>
                      </>
                    ) : room.activity === 'media' ? (
                      <>
                        <Play size={11} className="text-lu-accent flex-none" aria-hidden="true" />
                        <span>{t('Assistindo')}</span>
                      </>
                    ) : (
                      <>
                        <Dot tone="muted" />
                        <span>{t('Aguardando')}</span>
                      </>
                    )}
                  </span>
                </div>

                <div className="p-4 flex flex-col gap-2.5 flex-1 w-full box-border text-left">
                  <div className="text-[15.5px] font-semibold text-lu-text truncate leading-snug">
                    {room.name}
                  </div>

                  {room.mediaTitle && (
                    <div className="flex items-center gap-1.5 text-[12.5px] text-lu-muted min-w-0">
                      <Film size={13} className="flex-none text-lu-muted/80" aria-hidden="true" />
                      <span className="truncate">{room.mediaTitle}</span>
                    </div>
                  )}

                  <div className="flex items-center gap-1.5 text-[12px] text-lu-muted">
                    <Clock size={12.5} className="flex-none text-lu-muted/80" aria-hidden="true" />
                    <span>{formatRoomAge(room.createdAt, now)}</span>
                  </div>

                  <div className="mt-auto pt-2 flex items-center justify-between gap-2.5 min-w-0">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {room.members.length > 0 && (
                        <div className="flex items-center -space-x-2 flex-none">
                          {room.members.slice(0, 4).map((member, idx) => (
                            <CompactAvatar key={`${member.username}-${idx}`} member={member} size={24} />
                          ))}
                        </div>
                      )}
                      <span className="text-[12px] text-lu-muted truncate flex-1 min-w-0">
                        {namesText || room.hostName}
                      </span>
                    </div>
                    <span className="text-[12px] text-lu-muted whitespace-nowrap tabular flex-none">
                      {room.membersCount === 1 ? t('1 pessoa') : t('{n} pessoas', { n: room.membersCount })}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <RoomDetailModal room={selectedRoom} onClose={closeRoom} onJoin={handleJoinFromModal} />
    </div>
  );
};
