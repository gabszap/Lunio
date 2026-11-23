/**
 * Transforma tamanho de fonte e margem vertical (altura) em legendas ASS/SSA
 * para que os controles do player funcionem ao vivo no JASSUB (LibASS).
 */
export function transformAssStyle(
  assContent: string,
  fontSizePercent: number,
  bottomOffsetPercent: number
): string {
  const safeFont = Number.isFinite(fontSizePercent) ? fontSizePercent : 100;
  const safeOffset = Number.isFinite(bottomOffsetPercent) ? bottomOffsetPercent : 5;
  const sizeScale = Math.max(0.5, Math.min(2.5, safeFont / 100));
  const clampedOffset = Math.max(0, Math.min(30, safeOffset));

  if (Math.abs(sizeScale - 1) < 0.001 && clampedOffset === 5) {
    return assContent;
  }

  const lines = assContent.split(/\r?\n/);
  const eol = assContent.includes('\r\n') ? '\r\n' : '\n';

  // Detecta PlayResY em [Script Info] para calcular o deslocamento vertical proporcional (padrão LibASS: 288)
  let playResY = 288;
  for (const line of lines) {
    const m = /^\s*PlayResY\s*:\s*(\d+)/i.exec(line);
    if (m) {
      const val = parseInt(m[1], 10);
      if (val > 0) playResY = val;
      break;
    }
  }
  const marginDelta = Math.round(((clampedOffset - 5) / 100) * playResY);

  let inStyles = false;
  let fontsizeIdx = -1;
  let marginVIdx = -1;
  let alignmentIdx = -1;

  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const section = trimmed.toLowerCase();
      inStyles = section === '[v4+ styles]' || section === '[v4 styles]';
      fontsizeIdx = -1;
      marginVIdx = -1;
      alignmentIdx = -1;
      return line;
    }

    if (!inStyles) return line;

    if (/^Format\s*:/i.test(trimmed)) {
      const cols = trimmed
        .slice(trimmed.indexOf(':') + 1)
        .split(',')
        .map((c) => c.trim().toLowerCase());
      fontsizeIdx = cols.indexOf('fontsize');
      marginVIdx = cols.indexOf('marginv');
      alignmentIdx = cols.indexOf('alignment');
      return line;
    }

    if (/^Style\s*:/i.test(trimmed) && (fontsizeIdx >= 0 || marginVIdx >= 0)) {
      const colonIdx = line.indexOf(':');
      const prefix = line.slice(0, colonIdx + 1);
      const rest = line.slice(colonIdx + 1);
      const leadingSpace = /^\s*/.exec(rest)?.[0] ?? '';
      const parts = rest.trimStart().split(',');

      if (fontsizeIdx >= 0 && fontsizeIdx < parts.length && Math.abs(sizeScale - 1) >= 0.001) {
        const orig = parseFloat(parts[fontsizeIdx]);
        if (Number.isFinite(orig) && orig > 0) {
          parts[fontsizeIdx] = String(Math.max(8, Math.round(orig * sizeScale)));
        }
      }

      if (marginVIdx >= 0 && marginVIdx < parts.length && marginDelta !== 0) {
        const alignRaw = alignmentIdx >= 0 && alignmentIdx < parts.length ? parseInt(parts[alignmentIdx], 10) : 2;
        // Apenas estilos ancorados na base (ASS v4+ e SSA v4: 1, 2, 3) sobem/descem para não mover placas do topo
        const isBottomAligned = !Number.isFinite(alignRaw) || (alignRaw >= 1 && alignRaw <= 3);
        if (isBottomAligned) {
          const origMargin = parseInt(parts[marginVIdx], 10);
          if (Number.isFinite(origMargin)) {
            parts[marginVIdx] = String(Math.max(0, origMargin + marginDelta));
          }
        }
      }

      return `${prefix}${leadingSpace}${parts.join(',')}`;
    }

    return line;
  });

  return out.join(eol);
}
