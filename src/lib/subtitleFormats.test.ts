import { describe, expect, it } from 'vitest';
import { detectSubtitleFormat, validateAssDocument } from './subtitleFormats';

const ass = '[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Olá, mundo!\n';

describe('subtitle document formats', () => {
  it('recognizes ASS with BOM and commas in dialogue text', () => {
    expect(detectSubtitleFormat('\ufeff' + ass.replace(/\n/g, '\r\n'))).toBe('ass');
    expect(validateAssDocument(ass)).toMatchObject({ valid: true, events: 1 });
  });
  it('recognizes SSA and an intentionally empty valid script', () => {
    expect(detectSubtitleFormat(ass.replace('v4.00+', 'v4.00'))).toBe('ssa');
    expect(validateAssDocument(ass.split('Dialogue:')[0])).toMatchObject({ valid: true, events: 0 });
  });
  it('recognizes SRT and VTT without accepting arbitrary or HTML responses', () => {
    expect(detectSubtitleFormat('1\n00:00:01,000 --> 00:00:02,000\nOlá\nsegunda linha\n')).toBe('srt');
    expect(detectSubtitleFormat('WEBVTT\n\n00:01.000 --> 00:02.000\nOlá')).toBe('vtt');
    expect(detectSubtitleFormat('<html>' + 'error '.repeat(100) + '</html>')).toBeNull();
    expect(detectSubtitleFormat('<html>\n' + ass + '</html>')).toBeNull();
    expect(validateAssDocument('<html>\n' + ass + '</html>').valid).toBe(false);
  });
  it('rejects malformed or reversed dialogue timestamps', () => {
    expect(validateAssDocument(ass.replace('0:00:02.00', '0:00:00.00')).valid).toBe(false);
    expect(validateAssDocument(ass.replace('0:00:02.00', 'bad')).valid).toBe(false);
    expect(validateAssDocument(ass + 'Dialogue: truncated').valid).toBe(false);
  });
});
