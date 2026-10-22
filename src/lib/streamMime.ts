/** Extensão (minúscula, com ponto) do nome do arquivo e, na falta dele, do caminho da URL sem query. */
function extensionOf(url: string, filename?: string): string {
  const fromName = /\.([a-z0-9]{1,5})$/i.exec((filename ?? '').trim());
  if (fromName) return `.${fromName[1].toLowerCase()}`;
  let path = url.split(/[?#]/)[0];
  try {
    path = new URL(url).pathname;
  } catch {
    // URL relativa: vale o texto sem query
  }
  const fromUrl = /\.([a-z0-9]{1,5})$/i.exec(path);
  return fromUrl ? `.${fromUrl[1].toLowerCase()}` : '';
}

/** Tipo e contêiner de um stream de addon. Sem extensão conhecida vale `video/x-matroska`, como no fluxo de colar link. */
export function streamMediaInfo(url: string, filename?: string): { mimeType: string; isMkv: boolean } {
  const ext = extensionOf(url, filename);
  const mimeType = ext === '.mp4' || ext === '.m4v' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : 'video/x-matroska';
  return { mimeType, isMkv: ext === '.mkv' || /torrentio/i.test(url) };
}
