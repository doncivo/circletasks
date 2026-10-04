import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createHtmlAudioPlayer, type SoundPlayer } from '../../platform/focus';
import { formatTime } from '../../i18n/format';
import { getLocale } from '../../i18n';
import type { FocusWindowAction, FocusWindowState } from '../../platform/focus';
import { useLayout } from '../../ui/useLayout';
import { useAppContainer, useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { FocusView } from './FocusView';
import { focusStore } from './focusStore';
import { buildWindowState } from './focusViewModel';
import { focusChimeUrl } from './sounds';

/** Délai avant d'écrire la position de la mini-fenêtre après un déplacement (un déplacement émet de nombreux événements). */
const POSITION_SAVE_DELAY_MS = 400;

/**
 * Point d'ancrage du Focus dans la fenêtre principale (F-01) : restaure la session au démarrage, surveille le terme au retour au
 * premier plan, puis montre la session selon l'appareil :
 * - iPhone : écran plein (Focus.html) par-dessus l'application ;
 * - PC : mini-fenêtre système toujours au premier plan, pilotée par événements (D4) ; sans elle (navigateur de développement,
 *   tests), le même contenu s'affiche en panneau flottant dans la fenêtre principale.
 * L'état vit ici (écriture en base) : la mini-fenêtre ne fait qu'afficher et renvoyer ses ordres.
 */
export function FocusHost() {
  const container = useAppContainer();
  const layout = useLayout();
  const store = focusStore.get(container);
  const session = useFeatureStore(focusStore, (s) => s.session);
  const ended = useFeatureStore(focusStore, (s) => s.ended);
  const task = useFeatureStore(focusStore, (s) => s.task);
  const soundNonce = useFeatureStore(focusStore, (s) => s.soundNonce);
  const endSound = useFeatureStore(focusStore, (s) => s.endSound);
  const today = useFeatureStore(focusStore, (s) => s.today);
  const spaces = useAppStore((s) => s.spaces);
  const entities = useTaskEntities();
  const { focusWindow } = container;

  // Démarrage : session ouverte reprise dans son état exact, ou close à son terme prévu (F-01 critère 9).
  useEffect(() => {
    void store.getState().restore();
  }, [store]);

  // Retour au premier plan (iPhone) ou au réveil du PC : le terme est recalculé par horodatage, jamais attendu d'un tic.
  useEffect(() => {
    const check = (): void => {
      if (document.visibilityState !== 'hidden') void store.getState().checkElapsed();
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
    };
  }, [store]);

  // La tâche supprimée (corbeille) ou terminée ailleurs : la session continue, seul « Terminer la tâche » disparaît (critère 10).
  const taskId = task?.id ?? null;
  const taskInEntities = taskId ? entities.get(taskId) : undefined;
  const taskStatus = taskInEntities?.status;
  useEffect(() => {
    if (taskId && (!taskInEntities || taskStatus === 'done')) void store.getState().refreshTask();
  }, [store, taskId, taskInEntities, taskStatus]);

  const openSession = session ?? ended?.session ?? null;
  const live = taskId ? (entities.get(taskId) ?? task) : null;
  const space = openSession ? spaces.find((candidate) => candidate.id === openSession.spaceId) : undefined;

  const viewState: FocusWindowState | null = useMemo(() => {
    if (!openSession) return null;
    return buildWindowState({
      phase: ended ? 'ended' : openSession.pausedAt !== null ? 'paused' : 'running',
      session: openSession,
      title: live?.title ?? null,
      time: live?.time ? formatTime(live.time) : null,
      spaceName: space?.name ?? '',
      canFinishTask: live !== null && live.status === 'todo',
      today,
      soundEnabled: endSound,
      soundNonce,
      endedMinutes: ended?.minutes ?? 0,
      locale: getLocale(),
    });
  }, [openSession, live, space, soundNonce, endSound, ended, today]);

  // Carillon embarqué (F-04 D4) : celui du conteneur en test, sinon un élément Audio créé à la première fin.
  const player: SoundPlayer = useMemo(() => container.soundPlayer ?? createHtmlAudioPlayer(focusChimeUrl), [container]);

  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleAction = useCallback(
    (action: FocusWindowAction): void => {
      const state = store.getState();
      switch (action.type) {
        case 'duration':
          void state.setDuration(action.minutes === null ? null : action.minutes === 25 || action.minutes === 50 || action.minutes === 90 ? action.minutes : 25);
          break;
        case 'pause':
          void state.pause();
          break;
        case 'resume':
          void state.resume();
          break;
        case 'stop':
          void state.stop();
          break;
        case 'finishTask':
          void state.finishTask();
          break;
        case 'elapsed':
          void state.checkElapsed();
          break;
        case 'another':
          void state.another();
          break;
        case 'dismiss':
          state.dismissEnded();
          break;
        case 'moved':
          // Position mémorisée (F-01 critère 3), écrite une fois le déplacement terminé.
          if (positionTimer.current) clearTimeout(positionTimer.current);
          positionTimer.current = setTimeout(() => {
            void container.data.repos.settings.set('focus.windowPosition', { x: action.x, y: action.y }).catch(() => undefined);
          }, POSITION_SAVE_DELAY_MS);
          break;
        case 'ready':
          break;
      }
    },
    [store, container],
  );

  // PC avec mini-fenêtre système : ouverte avec la session, fermée quand elle disparaît, alimentée à chaque changement.
  const windowOpen = useRef(false);
  const active = viewState !== null;
  useEffect(() => {
    if (!focusWindow) return undefined;
    let disposed = false;
    let off: (() => void) | null = null;
    void focusWindow.onAction(handleAction).then((unsubscribe) => {
      if (disposed) unsubscribe();
      else off = unsubscribe;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [focusWindow, handleAction]);
  useEffect(() => {
    if (!focusWindow) return;
    if (!active) {
      if (windowOpen.current) void focusWindow.close();
      windowOpen.current = false;
      return;
    }
    void (async () => {
      if (!windowOpen.current) {
        windowOpen.current = true;
        const position = await container.data.repos.settings.get('focus.windowPosition').catch(() => null);
        await focusWindow.open(position);
      }
      if (viewState) await focusWindow.publish(viewState);
    })();
  }, [focusWindow, active, viewState, container]);

  // iPhone : l'écran plein remplace la fiche ouverte (une feuille modale resterait lue par les lecteurs d'écran sous l'écran Focus).
  useEffect(() => {
    if (active && layout === 'mobile') useNavigationStore.getState().closeDetail();
  }, [active, layout]);

  if (!viewState) return null;
  if (focusWindow) return null;
  return <FocusView state={viewState} variant={layout === 'mobile' ? 'screen' : 'panel'} clock={container.clock} onAction={handleAction} player={player} />;
}
