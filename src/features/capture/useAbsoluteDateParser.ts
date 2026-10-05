import { useEffect, useSyncExternalStore } from 'react';
import type { AbsoluteDateParser } from '../../domain/naturalDate';
import { getAbsoluteDateParser, loadAbsoluteDates, subscribeAbsoluteDateParser } from './absoluteDatesLoader';

/**
 * Analyseur des dates écrites pour un champ de saisie naturelle : lance le chargement et rend `null` jusqu'à son arrivée, puis
 * l'analyseur lui-même (dépendance ordinaire des analyses mémoïsées : la saisie déjà tapée est relue à l'arrivée).
 */
export function useAbsoluteDateParser(): AbsoluteDateParser | null {
  useEffect(() => {
    void loadAbsoluteDates();
  }, []);
  return useSyncExternalStore(subscribeAbsoluteDateParser, getAbsoluteDateParser);
}
