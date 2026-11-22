import { describe, expect, it } from 'vitest';
import { transformAssStyle } from './assStyle';

const SAMPLE_ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Trebuchet MS,60,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,40,1
Style: TopSign,Trebuchet MS,48,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,8,20,20,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Olá mundo
`;

describe('transformAssStyle', () => {
  it('retorna o texto intacto nos valores padrão (100% e 5%)', () => {
    expect(transformAssStyle(SAMPLE_ASS, 100, 5)).toBe(SAMPLE_ASS);
  });

  it('escala o Fontsize de todos os estilos proporcionalmente', () => {
    const out = transformAssStyle(SAMPLE_ASS, 150, 5);
    expect(out).toContain('Style: Default,Trebuchet MS,90,');
    expect(out).toContain('Style: TopSign,Trebuchet MS,72,');
    expect(out).toContain('Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Olá mundo');
  });

  it('ajusta MarginV apenas nos estilos alinhados na base (Alignment 1-3) sem mexer nos do topo', () => {
    // PlayResY=1080, offset 15% (+10% acima do padrão 5%) -> +108px em MarginV (40 -> 148)
    const out = transformAssStyle(SAMPLE_ASS, 100, 15);
    expect(out).toContain(',2,20,20,148,1');
    // TopSign tem Alignment=8 -> MarginV continua 30
    expect(out).toContain(',8,20,20,30,1');
  });

  it('não permite MarginV negativo ao descer abaixo do padrão', () => {
    const out = transformAssStyle(SAMPLE_ASS, 100, 0);
    // 40 - 54 = -14 -> clampado em 0
    expect(out).toContain(',2,20,20,0,1');
  });
});
