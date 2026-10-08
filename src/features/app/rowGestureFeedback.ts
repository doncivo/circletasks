import { useMemo } from 'react';
import type { Haptics } from '../../platform/haptics';
import type { RowGestureFeedback } from '../../ui';
import { useAppContainer } from './AppContainerContext';

/** Adaptateur retour haptique des gestes de ligne (A-07, ADR 0013 §1.3) : `src/ui` ne connaît pas `src/platform`. */
export function rowGestureFeedback(haptics: Haptics): RowGestureFeedback {
  return {
    threshold: () => haptics.selection(),
    open: () => haptics.impact('light'),
    commit: () => haptics.impact('medium'),
    succeeded: () => haptics.notification('success'),
    longPress: () => haptics.impact('light'),
  };
}

/** Retour haptique du conteneur courant (vide sur PC et dans le navigateur). */
export function useRowGestureFeedback(): RowGestureFeedback {
  const { haptics } = useAppContainer();
  return useMemo(() => rowGestureFeedback(haptics), [haptics]);
}
