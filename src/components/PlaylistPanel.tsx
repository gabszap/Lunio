import React, { useEffect, useRef, useState } from 'react';
import { GripVertical, ListPlus, ListVideo, Play, X } from 'lucide-react';
import { syncManager } from '../lib/sync';
import { detectMimeType, getYouTubeId, validateAndFormatUrl } from '../lib/media';
import { extractCleanTitleFromUrl } from '../lib/recent';
import { PLAYLIST_MAX_ITEMS, playlistUrlKey, type PlaylistItem } from '../types/sync';
import { t } from '../lib/i18n';
import { IconButton, PrimaryButton, TextInput, cx } from './ui';

/** Espaço entre os itens da lista (gap-2); entra na distância que os vizinhos andam durante o arraste. */
const ITEM_GAP = 8;

interface DragState {
  id: string;
  from: number;
  over: number;
  dy: number;
  /** Altura do item arrastado + espaço: quanto cada vizinho anda para abrir o buraco. */
  shift: number;
}

interface PlaylistPanelProps {
  /** Host: toca o item agora (tira da fila e carrega o vídeo). */
  onPlayItem: (item: PlaylistItem) => void;
}

/** Fila da sala, abaixo do player (estilo YouTube): vídeos para assistir em sequência. */
export const PlaylistPanel: React.FC<PlaylistPanelProps> = ({ onPlayItem }) => {
  const [playlist, setPlaylist] = useState<PlaylistItem[]>(() => syncManager.getPlaylist());
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const isHost = syncManager.isRoomHost();
  const myId = syncManager.getUser().id;
  const listRef = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Posições dos itens (em coordenadas do conteúdo da lista, para valer também com a lista rolada) medidas ao pegar.
  // `state` é a cópia viva do arraste: o React atrasa a renderização dos pointermove, e o pointerup precisa do valor mais novo.
  const dragRef = useRef<{ startY: number; tops: number[]; heights: number[]; state: DragState } | null>(null);

  useEffect(() => syncManager.subscribeState(() => setPlaylist([...syncManager.getPlaylist()])), []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = validateAndFormatUrl(link.trim());
    if (!/^https?:\/\//i.test(url)) {
      setError(t('Cole uma URL completa, começando com http:// ou https://'));
      return;
    }
    if (playlist.length >= PLAYLIST_MAX_ITEMS) {
      setError(t('A fila está cheia.'));
      return;
    }
    const ytId = getYouTubeId(url);
    const finalUrl = ytId ? `https://www.youtube.com/watch?v=${ytId}` : url;
    if (playlist.some((p) => playlistUrlKey(p.url) === playlistUrlKey(finalUrl))) {
      setError(t('Esse vídeo já está na fila.'));
      return;
    }
    if (ytId) {
      let title = t('Vídeo do YouTube');
      try {
        const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ytId}`)}`);
        if (res.ok) title = (await res.json()).title || title;
      } catch {
        // sem rede para o oEmbed: fica o título genérico
      }
      syncManager.emitPlaylistAdd({ url: `https://www.youtube.com/watch?v=${ytId}`, title, mimeType: 'video/youtube' });
    } else {
      syncManager.emitPlaylistAdd({ url, title: extractCleanTitleFromUrl(url) || 'Stream', mimeType: detectMimeType(url) });
    }
    setLink('');
    setError('');
  };

  const contentY = (clientY: number) => {
    const list = listRef.current!;
    return clientY - list.getBoundingClientRect().top + list.scrollTop;
  };

  const startDrag = (e: React.PointerEvent<HTMLButtonElement>, item: PlaylistItem, index: number) => {
    const list = listRef.current;
    if (!list || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // Sem isso o mouse começa a selecionar texto da página enquanto arrasta
    e.preventDefault();
    const els = Array.from(list.children) as HTMLElement[];
    const tops = els.map((el) => el.offsetTop);
    const heights = els.map((el) => el.offsetHeight);
    const state: DragState = { id: item.id, from: index, over: index, dy: 0, shift: heights[index] + ITEM_GAP };
    dragRef.current = { startY: contentY(e.clientY), tops, heights, state };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(state);
  };

  const moveDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    const list = listRef.current;
    const m = dragRef.current;
    if (!list || !m) return;
    const cur = m.state;
    // Perto da borda de cima/baixo da lista: rola para alcançar os itens que estão fora da vista
    const rect = list.getBoundingClientRect();
    if (e.clientY < rect.top + 28) list.scrollTop -= 10;
    else if (e.clientY > rect.bottom - 28) list.scrollTop += 10;

    const dy = contentY(e.clientY) - m.startY;
    const center = m.tops[cur.from] + m.heights[cur.from] / 2 + dy;
    // A nova posição é quantos outros itens têm o meio acima do centro do item arrastado
    let over = 0;
    m.tops.forEach((top, j) => {
      if (j !== cur.from && top + m.heights[j] / 2 < center) over++;
    });
    m.state = { ...cur, over, dy };
    setDrag(m.state);
  };

  const endDrag = (commit: boolean) => {
    const d = dragRef.current?.state;
    dragRef.current = null;
    setDrag(null);
    if (!commit || !d || d.over === d.from) return;
    // Mostra a ordem nova já, sem esperar a volta do servidor (que confirma ou desfaz em seguida)
    setPlaylist((cur) => {
      const next = [...cur];
      const [moved] = next.splice(d.from, 1);
      next.splice(d.over, 0, moved);
      return next;
    });
    syncManager.emitPlaylistMove(d.id, d.over);
  };

  // Esc cancela o arraste
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') endDrag(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const offsetFor = (i: number): number => {
    if (!drag) return 0;
    if (i === drag.from) return drag.dy;
    if (drag.from < drag.over && i > drag.from && i <= drag.over) return -drag.shift;
    if (drag.from > drag.over && i >= drag.over && i < drag.from) return drag.shift;
    return 0;
  };

  return (
    <section aria-label={t('Fila de vídeos')} className="rounded-[14px] bg-lu-surface border border-lu-border overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4 border-b border-lu-border">
        <h2 className="inline-flex items-center gap-2 text-[15px] font-semibold">
          <ListVideo size={18} />
          {t('Fila')}
          <span className="text-[13px] tabular text-lu-muted font-medium">{playlist.length}</span>
        </h2>
        <form onSubmit={add} className="flex-1 min-w-[240px] flex flex-col gap-1.5">
          <div className="flex gap-2">
            <TextInput
              value={link}
              onChange={(e) => {
                setLink(e.target.value);
                setError('');
              }}
              placeholder={t('Adicionar link do vídeo ou do YouTube')}
              aria-label={t('Link para adicionar à fila')}
              className="flex-1 min-w-0"
            />
            <PrimaryButton type="submit" disabled={!link.trim()} aria-label={t('Adicionar à fila')}>
              <ListPlus size={16} />
            </PrimaryButton>
          </div>
          {error && <span className="text-[12px] text-lu-error">{error}</span>}
        </form>
      </div>

      {playlist.length === 0 ? (
        <p className="px-5 py-6 text-[13px] text-lu-muted text-center">
          {t('A fila está vazia. Adicione links e o próximo toca sozinho quando o vídeo acabar.')}
        </p>
      ) : (
        <ol ref={listRef} className="relative max-h-[360px] overflow-y-auto custom-scrollbar p-3 flex flex-col gap-2">
          {playlist.map((item, i) => (
            <li
              key={item.id}
              style={drag ? { transform: `translateY(${offsetFor(i)}px)` } : undefined}
              className={cx(
                'flex items-center gap-3 p-2.5 pl-3 rounded-[12px] border',
                drag && 'select-none',
                drag?.id === item.id
                  ? 'relative z-10 bg-lu-elevated border-lu-border-strong shadow-[0_12px_32px_rgba(0,0,0,0.5)]'
                  : cx('bg-lu-elevated/60 border-lu-border', drag && 'transition-transform duration-150')
              )}
            >
              {isHost && (
                <IconButton
                  label={t('Arrastar para reordenar')}
                  size={36}
                  tone="muted"
                  className={cx('touch-none flex-none cursor-grab', drag?.id === item.id && 'cursor-grabbing')}
                  onPointerDown={(e) => startDrag(e, item, i)}
                  onPointerMove={moveDrag}
                  onPointerUp={() => endDrag(true)}
                  onPointerCancel={() => endDrag(false)}
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                    e.preventDefault();
                    syncManager.emitPlaylistMove(item.id, e.key === 'ArrowUp' ? 'up' : 'down');
                  }}
                >
                  <GripVertical size={16} />
                </IconButton>
              )}
              <span className="text-[12px] tabular text-lu-muted w-5 flex-none text-center">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold truncate" title={item.title}>{item.title}</div>
                <div className="text-[12px] text-lu-muted truncate">{t('Adicionado por {name}', { name: item.addedBy })}</div>
              </div>
              {isHost && (
                <>
                  <IconButton label={t('Tocar agora')} size={36} onClick={() => onPlayItem(item)}>
                    <Play size={15} />
                  </IconButton>
                </>
              )}
              {(isHost || item.addedById === myId) && (
                <IconButton label={t('Remover da fila')} size={36} tone="muted" onClick={() => syncManager.emitPlaylistRemove(item.id)}>
                  <X size={15} />
                </IconButton>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
