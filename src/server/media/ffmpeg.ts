/**
 * Só http(s) e rede: o FFmpeg não pode abrir file:, concat:, subfile: etc. por causa de uma URL
 * ou playlist maliciosa. Vai antes do `-i` em todo comando.
 */
export const FFMPEG_NET_ONLY = ['-protocol_whitelist', 'http,https,tcp,tls,crypto'];
