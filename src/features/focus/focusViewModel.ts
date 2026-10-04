import type { FocusSessionRecord } from '../../domain/focusSession';
import type { FocusSession } from '../../domain/model';
import type { IsoDateTime, SpaceId, TaskId } from '../../domain/types';
import type { FocusPhase, FocusWindowState } from '../../platform/focus';

/** Enregistrement du domaine relu depuis la photographie envoyée à une vue (instants ISO). */
export function recordOf(session: FocusWindowState['session']): FocusSessionRecord {
  return {
    id: session.id as FocusSessionRecord['id'],
    taskId: null as TaskId | null,
    spaceId: '' as SpaceId,
    plannedMin: session.plannedMin,
    startedAt: session.startedAt as IsoDateTime,
    endedAt: session.endedAt as IsoDateTime | null,
    pausedSec: session.pausedSec,
    pausedAt: session.pausedAt as IsoDateTime | null,
  };
}

export interface WindowStateInput {
  readonly phase: FocusPhase;
  readonly session: FocusSession;
  readonly title: string | null;
  readonly time: string | null;
  readonly spaceName: string;
  readonly canFinishTask: boolean;
  readonly today: { readonly minutes: number; readonly sessions: number };
  readonly soundEnabled: boolean;
  readonly soundNonce: number;
  readonly endedMinutes: number;
  readonly locale: 'fr' | 'en';
}

/** Photographie de la session pour une vue (écran iPhone, panneau, mini-fenêtre) : horodatages seulement. */
export function buildWindowState(input: WindowStateInput): FocusWindowState {
  const { session } = input;
  return {
    phase: input.phase,
    session: {
      id: session.id,
      plannedMin: session.plannedMin,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      pausedSec: session.pausedSec,
      pausedAt: session.pausedAt,
    },
    title: input.title,
    time: input.time,
    spaceName: input.spaceName,
    canFinishTask: input.canFinishTask,
    today: input.today,
    sound: { enabled: input.soundEnabled, nonce: input.soundNonce },
    endedMinutes: input.endedMinutes,
    locale: input.locale,
  };
}
