import React from 'react';
import { SearchX, Users, RefreshCw } from 'lucide-react';
import {
  CatalogItem,
  CatalogManifest,
  CatalogRow,
  fetchRow,
  rowTitles,
} from '../../lib/catalog';
import { GhostButton, PrimaryButton } from '../ui';
import { t } from '../../lib/i18n';
import { Row } from './Row';

// ───────────────────────── Fileiras da Home (do manifesto da fonte) ─────────────────────────

export const HomeRows: React.FC<{
  manifest: CatalogManifest | null | 'error';
  onOpen: (item: CatalogItem) => void;
  onRetry: () => void;
  onCreateRoom: () => void;
}> = ({ manifest, onOpen, onRetry, onCreateRoom }) => {
  if (manifest === null) {
    return (
      <>
        {[0, 1].map((i) => (
          <Row key={i} title=" " load={async () => []} onOpen={onOpen} lazy />
        ))}
      </>
    );
  }
  if (manifest === 'error') {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <span className="w-[72px] h-[72px] rounded-[20px] bg-lu-surface border border-lu-border text-lu-muted flex items-center justify-center">
          <SearchX size={32} />
        </span>
        <h1 className="mt-2 mb-0 text-[22px] font-semibold tracking-[-0.02em]">{t('O catálogo não respondeu')}</h1>
        <p className="m-0 max-w-[440px] text-[14px] text-lu-muted">
          {t('O catálogo está fora do ar agora. Se você já tem o vídeo, dá pra criar a sala direto.')}
        </p>
        <div className="flex flex-wrap justify-center gap-3 mt-3">
          <GhostButton onClick={onRetry}>
            <RefreshCw size={16} />
            <span>{t('Tentar de novo')}</span>
          </GhostButton>
          <PrimaryButton onClick={onCreateRoom}>
            <Users size={18} />
            <span>{t('Criar sala com um vídeo')}</span>
          </PrimaryButton>
        </div>
      </div>
    );
  }
  if (manifest.rows.length === 0) {
    return <p className="m-0 text-center text-[14px] text-lu-muted py-10">{t('Esta fonte não tem listas para mostrar. Use a busca.')}</p>;
  }
  const titles = rowTitles(manifest.rows);
  return (
    <>
      {manifest.stale && (
        <p className="m-0 text-[13px] text-lu-muted text-center">{t('O catálogo está fora do ar; mostrando o último conteúdo guardado.')}</p>
      )}
      {manifest.rows.map((row: CatalogRow, i) => (
        <Row key={`${row.type}:${row.id}`} title={titles[i]} load={() => fetchRow(row)} onOpen={onOpen} lazy />
      ))}
    </>
  );
};
