import type { SubtitleFormat } from '../types/media';

const normalize = (content: string) => content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

function assTime(value: string): number | null {
  const match = /^(\d+):([0-5]\d):([0-5]\d)\.(\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`);
}

export function validateAssDocument(content: string): { valid: boolean; events: number; reason?: string } {
  const text = normalize(content);
  if (/^\s*<(?:!doctype\b|html\b|head\b|body\b)/i.test(text)) return { valid: false, events: 0, reason: 'html_response' };
  if (!/^\[Script Info\]\s*$/im.test(text)) return { valid: false, events: 0, reason: 'missing_script_info' };
  let inEvents = false;
  let format: string[] = [];
  let events = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { inEvents = /^\[Events\]$/i.test(line); continue; }
    if (!inEvents) continue;
    if (/^Format\s*:/i.test(line)) { format = line.slice(line.indexOf(':') + 1).split(',').map(s => s.trim().toLowerCase()); continue; }
    if (!/^Dialogue\s*:/i.test(line)) continue;
    const fields = line.slice(line.indexOf(':') + 1).trimStart().split(',');
    if (!format.includes('start') || !format.includes('end') || format.at(-1) !== 'text' || fields.length < format.length) return { valid: false, events, reason: 'invalid_event_format' };
    const start = assTime(fields[format.indexOf('start')]);
    const end = assTime(fields[format.indexOf('end')]);
    if (start === null || end === null || end < start) return { valid: false, events, reason: 'invalid_event_time' };
    events++;
  }
  const valid = format.includes('start') && format.includes('end') && format.at(-1) === 'text';
  return { valid, events, ...(valid ? {} : { reason: 'missing_event_format' }) };
}

export function detectSubtitleFormat(content: string): Exclude<SubtitleFormat, 'unknown'> | null {
  const text = normalize(content).trim();
  if (/^<(?:!doctype\b|html\b|head\b|body\b)/i.test(text)) return null;
  if (/^\[Script Info\]/im.test(text)) {
    if (!validateAssDocument(text).valid) return null;
    return /^ScriptType:\s*v4\.00\s*$/im.test(text) || /^\[V4 Styles\]/im.test(text) ? 'ssa' : 'ass';
  }
  if (/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text)) return 'vtt';
  if (/^\d{2,}:[0-5]\d:[0-5]\d,\d{3}\s+-->\s+\d{2,}:[0-5]\d:[0-5]\d,\d{3}(?:\s.*)?$/m.test(text)) return 'srt';
  return null;
}

export function requireSubtitleFormat(content: string) {
  const format = detectSubtitleFormat(content);
  if (!format) throw Object.assign(new Error('Conteúdo de legenda inválido ou formato não reconhecido.'), { code: 'SUBTITLE_INVALID' });
  return format;
}
