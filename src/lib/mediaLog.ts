/** Só o host e o nome do arquivo, para o console: o link inteiro pode ter a chave da pessoa (TorBox, addons). */
export function describeSourceForLog(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    let file = last;
    try {
      file = decodeURIComponent(last);
    } catch {
      // nome com % solto: fica como veio
    }
    return /\.(mkv|mp4|m4v|webm|mov|avi|ts|m3u8)$/i.test(file) ? `${u.host}/…/${file}` : u.host;
  } catch {
    return 'link inválido';
  }
}
