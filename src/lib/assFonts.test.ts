import { describe, expect, it } from 'vitest';
import { collectAssFontNames, selectFontsToLoad } from './assFonts';

const ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic
Style: Default,Arial,48,&H00FFFFFF,0,0
Style: Sign,@Trebuchet MS,40,&H00FFFFFF,-1,0
Style: Karaoke , Gandhi Sans ,36,&H00FFFFFF,0,0

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Olá {\\fnComic Sans MS\\b1}mundo{\\r} de {\\fn@Noto Sans CJK JP}novo
Dialogue: 0,0:00:04.00,0:00:05.00,Sign,,0,0,0,,{\\an8\\fnArial}placa
`;

describe('collectAssFontNames', () => {
  it('junta o Fontname dos estilos e os \\fn dos eventos, em minúsculas e sem o "@" vertical', () => {
    const used = collectAssFontNames(ASS);
    expect([...used].sort()).toEqual(['arial', 'comic sans ms', 'gandhi sans', 'noto sans cjk jp', 'trebuchet ms']);
  });

  it('acha a coluna do Fontname pela linha Format (ordem diferente) e ignora outras seções', () => {
    const ass = `[V4+ Styles]\nFormat: Fontsize, Name, Fontname\nStyle: 40,Default,Verdana\n\n[Fonts]\nStyle: 1,2,Falsa\n`;
    expect([...collectAssFontNames(ass)]).toEqual(['verdana']);
  });

  it('legenda sem estilos nem \\fn não cita fonte nenhuma', () => {
    expect(collectAssFontNames('[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,oi').size).toBe(0);
    expect(collectAssFontNames('').size).toBe(0);
  });
});

describe('selectFontsToLoad', () => {
  const fonts = [
    { index: 10, url: '/f/10' },
    { index: 11, url: '/f/11' },
    { index: 12, url: '/f/12' },
    { index: 13, url: '/f/13' },
  ];
  const map = {
    complete: true,
    fonts: {
      '10': ['arial', 'arial bold'],
      '11': ['trebuchet ms', 'trebuchet ms bold'],
      '12': ['impact'],
      '13': null, // nomes desconhecidos: carrega por garantia
    } as Record<string, string[] | null>,
  };

  it('carrega só as fontes citadas pela legenda (mais as de nomes desconhecidos)', () => {
    const { urls, skipped } = selectFontsToLoad(fonts, map, new Set(['arial', 'gandhi sans']));
    expect(urls).toEqual(['/f/10', '/f/13']);
    expect(skipped).toBe(2);
  });

  it('todas as variantes de uma família entram juntas (negrito, itálico)', () => {
    const family = { complete: true, fonts: { '10': ['trebuchet ms'], '11': ['trebuchet ms', 'trebuchet ms bold'] } as Record<string, string[] | null> };
    const { urls } = selectFontsToLoad(fonts.slice(0, 2), family, new Set(['trebuchet ms']));
    expect(urls).toEqual(['/f/10', '/f/11']);
  });

  it('sem mapa, ou com o mapa incompleto, carrega todas como antes', () => {
    expect(selectFontsToLoad(fonts, null, new Set(['arial'])).urls).toHaveLength(4);
    expect(selectFontsToLoad(fonts, { complete: false, fonts: {} }, new Set(['arial'])).urls).toHaveLength(4);
  });

  it('fonte sem url fica de fora (não há o que carregar)', () => {
    expect(selectFontsToLoad([{ index: 1 }, { index: 2, url: '/f/2' }], null, new Set()).urls).toEqual(['/f/2']);
  });
});
