/** Chave do "continuar de onde parou" no localStorage (uma por vídeo). */
export const getProgressStorageKey = (url: string) => `lunio_progress_${encodeURIComponent(url.slice(0, 100))}`;
