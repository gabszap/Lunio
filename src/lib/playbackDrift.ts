export interface DriftCorrectionResult {
  drift: number;
  action: 'none' | 'rate_speedup' | 'rate_slowdown' | 'seek';
  targetTime: number;
}

/** O tolerável é assimétrico: o espectador mais adiantado pode ver o que o Host ainda não viu. */
export function decideDrift(localTime: number, targetTime: number): DriftCorrectionResult {
  const drift = localTime - targetTime;
  let action: DriftCorrectionResult['action'] = 'none';
  if (drift > 0.5 || drift < -1.2) action = 'seek';
  else if (drift > 0.12) action = 'rate_slowdown';
  else if (drift < -0.25) action = 'rate_speedup';
  return { drift, action, targetTime };
}

export function getDriftPlaybackRate(action: Exclude<DriftCorrectionResult['action'], 'seek'>, nominalRate: number) {
  if (action === 'rate_slowdown') return nominalRate * 0.85;
  if (action === 'rate_speedup') return nominalRate * 1.08;
  return nominalRate;
}
