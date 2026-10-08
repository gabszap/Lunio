import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ListPlus, ListVideo, Play, X } from 'lucide-react';
import { syncManager } from '../lib/sync';
import { detectMimeType, getYouTubeId, validateAndFormatUrl } from '../lib/media';
import { extractCleanTitleFromUrl } from '../lib/recent';
import { PLAYLIST_MAX_ITEMS, type PlaylistItem } from '../types/sync';
import { IconButton, PrimaryButton, TextInput } from './ui';

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

  useEffect(() => syncManager.subscribeState(() => setPlaylist([...syncManager.getPlaylist()])), []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = validateAndFormatUrl(link.trim());
    if (!/^https?:\/\//i.test(url)) {
      setError('Cole uma URL completa, começando com http:// ou https://');
      return;
    }
    if (playlist.length >= PLAYLIST_MAX_ITEMS) {
      setError('A fila está cheia.');
      return;
    }
    const ytId = getYouTubeId(url);
    if (ytId) {
      let title = 'Vídeo do YouTube';
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

  return (
    <section aria-label="Fila de vídeos" className="rounded-[14px] bg-lu-surface border border-lu-border overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4 border-b border-lu-border">
        <h2 className="inline-flex items-center gap-2 text-[15px] font-semibold">
          <ListVideo size={18} />
          Fila
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
              placeholder="Adicionar link do vídeo ou do YouTube"
              aria-label="Link para adicionar à fila"
              className="flex-1 min-w-0"
            />
            <PrimaryButton type="submit" disabled={!link.trim()} aria-label="Adicionar à fila">
              <ListPlus size={16} />
            </PrimaryButton>
          </div>
          {error && <span className="text-[12px] text-lu-error">{error}</span>}
        </form>
      </div>

      {playlist.length === 0 ? (
        <p className="px-5 py-6 text-[13px] text-lu-muted text-center">
          A fila está vazia. Adicione links e o próximo toca sozinho quando o vídeo acabar.
        </p>
      ) : (
        <ol className="max-h-[360px] overflow-y-auto custom-scrollbar p-3 flex flex-col gap-2">
          {playlist.map((item, i) => (
            <li key={item.id} className="flex items-center gap-3 p-2.5 pl-3 rounded-[12px] bg-lu-elevated/60 border border-lu-border">
              <span className="text-[12px] tabular text-lu-muted w-5 flex-none text-center">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold truncate" title={item.title}>{item.title}</div>
                <div className="text-[12px] text-lu-muted truncate">Adicionado por {item.addedBy}</div>
              </div>
              {isHost && (
                <>
                  <IconButton label="Tocar agora" size={36} onClick={() => onPlayItem(item)}>
                    <Play size={15} />
                  </IconButton>
                  <IconButton label="Subir" size={36} disabled={i === 0} onClick={() => syncManager.emitPlaylistMove(item.id, 'up')}>
                    <ArrowUp size={15} />
                  </IconButton>
                  <IconButton label="Descer" size={36} disabled={i === playlist.length - 1} onClick={() => syncManager.emitPlaylistMove(item.id, 'down')}>
                    <ArrowDown size={15} />
                  </IconButton>
                </>
              )}
              {(isHost || item.addedById === myId) && (
                <IconButton label="Remover da fila" size={36} tone="muted" onClick={() => syncManager.emitPlaylistRemove(item.id)}>
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
