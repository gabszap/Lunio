/** Positive offsets advance subtitles, matching JASSUB's mediaTime + timeOffset. */
export function effectiveSubtitleOffset(timelineOriginSec: number, manualDelaySec: number): number {
  return timelineOriginSec + manualDelaySec;
}

export function shiftCueWindow(start: number, end: number, offset: number): { start: number; end: number } | null {
  const shiftedEnd = end - offset;
  if (shiftedEnd <= 0) return null;
  return { start: Math.max(0, start - offset), end: shiftedEnd };
}
