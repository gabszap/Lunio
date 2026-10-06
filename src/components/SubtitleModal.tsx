import React, { useRef, useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { srtToVtt } from '../lib/media';
import { logger } from '../lib/logger';
import type { SubtitleTrack } from '../types/media';
import { FieldLabel, Modal, ModalHeader, PrimaryButton, Segmented, TextButton, TextInput } from './ui';

interface SubtitleModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (track: SubtitleTrack) => void;
}

export const SubtitleModal: React.FC<SubtitleModalProps> = ({ open, onClose, onAdd }) => {
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [type, setType] = useState<'ass' | 'vtt'>('ass');
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setLabel('');
    setUrl('');
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const lower = file.name.toLowerCase();
    const isAss = lower.endsWith('.ass') || lower.endsWith('.ssa');
    let src: string;
    let trackType: 'ass' | 'vtt' = isAss ? 'ass' : 'vtt';

    if (lower.endsWith('.srt')) {
      // SRT vira WebVTT na hora
      const vtt = srtToVtt(await file.text());
      src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      trackType = 'vtt';
      logger.info(`[Legenda] SRT convertido para WebVTT: ${file.name}`);
    } else {
      src = URL.createObjectURL(file);
    }

    onAdd({ src, label: file.name, language: 'custom', type: trackType, default: true });
    logger.info(`[Legenda] Arquivo adicionado: ${file.name}`);
    onClose();
  };

  const handleUrl = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    const track: SubtitleTrack = {
      src: url.trim(),
      label: label.trim() || `Legenda ${type.toUpperCase()}`,
      language: 'pt',
      type,
      default: true,
    };
    onAdd(track);
    logger.info(`[Legenda] Adicionada por URL: ${track.label} (${type.toUpperCase()})`);
    reset();
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} label="Adicionar legenda">
      <ModalHeader title="Adicionar legenda" description="Envie um arquivo ou aponte para uma URL." onClose={onClose} />

      <input ref={fileRef} type="file" accept=".ass,.ssa,.vtt,.srt" className="sr-only" tabIndex={-1} onChange={handleFile} />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="w-full flex flex-col items-center gap-1.5 px-4 py-5 box-border rounded-[14px] bg-lu-bg2 border border-dashed border-white/16 text-lu-text hover:bg-lu-elevated"
      >
        <span className="flex text-lu-accent">
          <Upload size={22} />
        </span>
        <span className="text-[14px] font-semibold">Carregar arquivo local</span>
        <span className="text-[12px] text-lu-muted">.ass, .ssa, .srt ou .vtt · .srt é convertido automaticamente para WebVTT</span>
      </button>

      <div className="flex items-center gap-3 text-[12px] text-lu-disabled">
        <div className="flex-1 h-px bg-lu-border" />
        ou por URL
        <div className="flex-1 h-px bg-lu-border" />
      </div>

      <form onSubmit={handleUrl} className="flex flex-col gap-5">
        <div>
          <FieldLabel htmlFor="sub-label" className="!font-medium">
            Nome da faixa
          </FieldLabel>
          <TextInput id="sub-label" placeholder="Ex.: Português (ASS)" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div>
          <FieldLabel htmlFor="sub-url" className="!font-medium">
            URL da legenda
          </FieldLabel>
          <TextInput id="sub-url" type="url" placeholder="https://…/legenda.ass" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div>
          <span className="block text-[13px] font-medium mb-2">Formato</span>
          <Segmented
            label="Formato da legenda"
            value={type}
            onChange={(v) => setType(v as 'ass' | 'vtt')}
            options={[
              { value: 'ass', label: 'ASS / SSA' },
              { value: 'vtt', label: 'VTT' },
            ]}
          />
          <p className="mt-2 mb-0 text-[12px] text-lu-muted">
            ASS usa renderização avançada (JASSUB). VTT usa o renderizador nativo do navegador.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <TextButton onClick={onClose} className="!px-4">
            Cancelar
          </TextButton>
          <PrimaryButton type="submit" disabled={!url.trim()}>
            <Plus size={18} />
            <span>Adicionar legenda</span>
          </PrimaryButton>
        </div>
      </form>
    </Modal>
  );
};
