import React, { useEffect, useState } from 'react';
import { CircleAlert, Link as LinkIcon, RefreshCw, Trash2 } from 'lucide-react';
import { AddonError, MAX_ADDONS, VideoAddon, addAddon, addonHost, loadAddons, refreshAddon, removeAddon } from '../../lib/addons';
import { BigInput, FieldLabel, Hint, Modal, ModalHeader, PrimaryButton, Spinner, TextButton } from '../ui';
import { t } from '../../lib/i18n';

interface AddonsPanelProps {
  open: boolean;
  onClose: () => void;
  onChange: (addons: VideoAddon[]) => void;
}

// Nenhuma mensagem inclui a URL: ela carrega a configuração da pessoa
function errorText(e: unknown): string {
  if (e instanceof AddonError) {
    switch (e.code) {
      case 'invalid_url':
        return t('Cole a URL do manifesto (termina em /manifest.json)');
      case 'no_stream':
        return t('Esse addon não oferece streams');
      case 'limit':
        return t('Limite de 10 addons');
      case 'duplicate':
        return t('Esse addon já foi adicionado');
    }
  }
  return t('Não consegui abrir esse endereço');
}

/** Gerencia os addons de vídeo (Stremio) da pessoa; ficam só neste navegador. */
export const AddonsPanel: React.FC<AddonsPanelProps> = ({ open, onClose, onChange }) => {
  const [addons, setAddons] = useState<VideoAddon[]>([]);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAddons(loadAddons());
    setUrl('');
    setError('');
  }, [open]);

  const update = (list: VideoAddon[]) => {
    setAddons(list);
    onChange(list);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || adding) return;
    setAdding(true);
    setError('');
    try {
      await addAddon(url);
      setUrl('');
      update(loadAddons());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setAdding(false);
    }
  };

  const refresh = async (id: string) => {
    setRefreshing(id);
    setError('');
    try {
      update(await refreshAddon(id));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRefreshing(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} label={t('Addons')}>
      <ModalHeader title={t('Addons')} description={t('Fontes de vídeo compatíveis com Stremio. A URL fica só neste navegador.')} onClose={onClose} />

      <form onSubmit={submit}>
        <FieldLabel htmlFor="addon-url" className="!font-medium">
          {t('URL do manifesto')}
        </FieldLabel>
        <div className="flex gap-3">
          <BigInput
            id="addon-url"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://…/manifest.json"
            value={url}
            invalid={Boolean(error)}
            wrapperClassName="flex-1 min-w-0"
            onChange={(e) => {
              setUrl(e.target.value);
              setError('');
            }}
            icon={<LinkIcon size={18} />}
          />
          <PrimaryButton type="submit" size="lg" disabled={!url.trim() || adding}>
            {adding && <Spinner size={16} />}
            <span>{t('Adicionar')}</span>
          </PrimaryButton>
        </div>
        {error && (
          <Hint role="alert" tone="error">
            <CircleAlert size={14} />
            {error}
          </Hint>
        )}
      </form>

      {addons.length > 0 ? (
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {addons.map((a) => (
            <li key={a.id} className="flex items-center gap-3 p-3 rounded-[12px] bg-lu-bg2 border border-lu-border">
              <span className="flex flex-col min-w-0 flex-1">
                <span className="text-[14px] font-semibold truncate">{a.name}</span>
                <span className="text-[12px] text-lu-muted truncate">{addonHost(a)}</span>
              </span>
              <TextButton size="sm" disabled={refreshing === a.id} onClick={() => refresh(a.id)}>
                {refreshing === a.id ? <Spinner size={14} /> : <RefreshCw size={14} />}
                {t('Atualizar')}
              </TextButton>
              <TextButton size="sm" onClick={() => update(removeAddon(a.id))}>
                <Trash2 size={14} />
                {t('Remover')}
              </TextButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-[14px] text-lu-muted">{t('Nenhum addon adicionado.')}</p>
      )}
      <p className="m-0 -mt-2 text-[12px] text-lu-muted">{t('{n} de {max} addons', { n: addons.length, max: MAX_ADDONS })}</p>
    </Modal>
  );
};
