/** Chave do "continuar de onde parou" no localStorage (uma por vídeo). */
export const getProgressStorageKey = (url: string) => `streamplayer_progress_${encodeURIComponent(url.slice(0, 100))}`;
