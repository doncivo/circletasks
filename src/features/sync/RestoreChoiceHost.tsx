import { useState } from 'react';
import { lazyScreen } from '../app/lazyScreens';
import { useFeatureStore } from '../app/AppContainerContext';
import { syncStore } from './syncStore';

/**
 * Y-FIX-04 (décision d'Ali du 2026-10-18 : tout écran qui ne s'affiche pas au démarrage est chargé à la demande) : la fenêtre de choix après
 * une restauration et ses textes (`fr.syncRestore.ts`) forment un bloc à part, importé au moment où la phase `restore-choice` apparaît ou
 * qu'un choix est rouvert (« Synchroniser »), jamais au départ (`tests/bundle/startBundle.test.ts`). Une fois rendue, la fenêtre reste
 * montée pour la session (elle ne s'ouvre d'elle-même qu'une fois, règle de `RestoreChoiceDialog`).
 */
const RestoreChoiceDialogLazy = lazyScreen<object>(() => import('./RestoreChoiceDialog').then((m) => ({ default: m.RestoreChoiceDialog })), 'restorechoicedialog', { onDemand: true });

export function RestoreChoiceHost() {
  const wanted = useFeatureStore(syncStore, (s) => s.status.phase === 'restore-choice' || s.restore !== null);
  const [mounted, setMounted] = useState(false);
  if (wanted && !mounted) setMounted(true);
  return mounted || wanted ? <RestoreChoiceDialogLazy /> : null;
}
