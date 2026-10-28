import { describe, expect, it } from 'vitest';
import { describeSourceForLog } from './mediaLog';

describe('describeSourceForLog', () => {
  it('mostra o host e o nome do arquivo, sem caminho, chave nem parâmetros', () => {
    expect(describeSourceForLog('https://cdn.exemplo.com/dl/abc123SEGREDO/Anime%20-%2001.mkv?token=SEGREDO&x=1')).toBe('cdn.exemplo.com/…/Anime - 01.mkv');
  });

  it('sem nome de vídeo no caminho, só o host (a chave pode estar no caminho ou na query)', () => {
    expect(describeSourceForLog('https://api.exemplo.com/v1/requestdl?token=SEGREDO&file_id=9')).toBe('api.exemplo.com');
    expect(describeSourceForLog('https://api.exemplo.com/dl/SEGREDO')).toBe('api.exemplo.com');
  });

  it('link inválido não vaza o texto', () => {
    expect(describeSourceForLog('não é url SEGREDO')).toBe('link inválido');
  });
});
