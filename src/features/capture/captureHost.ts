import type { CaptureContextSnapshot, CaptureMainBridge, CaptureReply } from '../../platform/capture';
import { logDesktopFailure } from '../../platform';
import { getFirstWeekday } from '../../i18n/formatPrefs';
import { useAppStore } from '../app/appStore';
import type { AppContainer } from '../app/container';
import { createTaskFromCaptureText } from './captureUseCases';

export interface CaptureHost {
  /** Retire les écouteurs ; sûr avant la fin de l'initialisation et idempotent. */
  dispose(): void;
}

/** Ce que la mini-fenêtre doit savoir pour proposer des espaces et des projets (elle n'ouvre jamais la base). */
export function contextSnapshot(): CaptureContextSnapshot {
  const { spaces, projects, spaceFilter } = useAppStore.getState();
  return {
    spaces: spaces.map(({ id, name, sortOrder, color }) => ({ id, name, sortOrder, color })),
    projects: projects.map(({ id, spaceId, name, archived, sortOrder, deletedAt, color }) => ({ id, spaceId, name, archived, sortOrder, deletedAt, color })),
    spaceFilter,
    firstWeekday: getFirstWeekday(),
  };
}

/**
 * Fenêtre principale, seule à écrire (Q-01 critère 9, décision D1) : reçoit `capture:submit`, crée la tâche comme Aujourd'hui, répond
 * `capture:done`, et tient la mini-fenêtre au courant des espaces et projets. Aucune erreur ne remonte : un échec est journalisé.
 */
export function startCaptureHost(container: AppContainer, bridge: CaptureMainBridge): CaptureHost {
  let disposed = false;
  const stops: Array<() => void> = [];
  const keep = (promise: Promise<() => void>, label: string): void => {
    promise.then(
      (stop) => (disposed ? stop() : stops.push(stop)),
      (error: unknown) => logDesktopFailure(label, error),
    );
  };

  // Le contexte n'est renvoyé que s'il a changé (sauf demande explicite de la mini-fenêtre) : pas de rafale d'événements.
  let lastPublished = '';
  const publish = (force = false): void => {
    const snapshot = contextSnapshot();
    const signature = JSON.stringify(snapshot);
    if (!force && signature === lastPublished) return;
    lastPublished = signature;
    bridge.publishContext(snapshot).catch((error: unknown) => logDesktopFailure('capture-context', error));
  };

  keep(
    bridge.onSubmit(async (request): Promise<CaptureReply> => {
      const result = await createTaskFromCaptureText(container, request.text, request.ignored);
      return result.ok ? { ok: true, title: result.task.title } : { ok: false, error: result.error };
    }),
    'capture-submit',
  );
  keep(bridge.onContextRequest(() => publish(true)), 'capture-context-request');

  // Le contexte part au démarrage puis à chaque changement d'espaces, de projets ou de filtre.
  publish(true);
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.spaces !== previous.spaces || state.projects !== previous.projects || state.spaceFilter !== previous.spaceFilter) publish();
  });

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const stop of stops) stop();
    },
  };
}
