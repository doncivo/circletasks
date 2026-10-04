import { useEffect, useState } from 'react';
import type { Clock } from '../../domain/clock';

/** Instant courant (ms) relu toutes les 30 s : « Mis à jour il y a N min » se met à jour sans action (K-03 critère 8). */
export function useMinuteClock(clock: Clock): number {
  const [nowMs, setNowMs] = useState(() => clock.nowMs());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(clock.nowMs()), 30_000);
    return () => clearInterval(timer);
  }, [clock]);
  return nowMs;
}
