import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Clock } from '../../domain/clock';
import {
  FOCUS_DURATIONS_MIN,
  activeMinutes,
  currentPauseMs,
  displayClock,
  elapsedActiveMs,
  formatClock,
  isElapsed,
  isLongPause,
  remainingFraction,
} from '../../domain/focusSession';
import { t } from '../../i18n';
import { formatFocusDuration } from '../../i18n/formatFocus';
import type { FocusWindowAction, FocusWindowState, SoundPlayer } from '../../platform/focus';
import { Icon } from '../../ui';
import { useFocusTrap } from '../../ui/useFocusTrap';
import { recordOf } from './focusViewModel';
import { useNow } from './useNow';
import './FocusView.css';

export type FocusVariant = 'screen' | 'window' | 'panel';

export interface FocusViewProps {
  /** Photographie de la session : horodatages, jamais un temps restant (F-01 critère 5). */
  readonly state: FocusWindowState;
  readonly variant: FocusVariant;
  readonly clock: Clock;
  readonly onAction: (action: FocusWindowAction) => void;
  /** Incrémenté quand le système demande la fermeture de la fenêtre (croix de la barre de titre) : ouvre la confirmation. */
  readonly closeRequests?: number;
  /** Son de fin (F-04) : joué par la vue qui affiche la session (mini-fenêtre PC ou écran iPhone), jamais par les deux. */
  readonly player?: SoundPlayer | null;
}

/** Circonférence du cercle de rayon 130 (Focus.html : stroke-dasharray 816.8). */
const RING_LENGTH = 816.8;

/**
 * Écran de session Focus (Focus.html), le même pour l'iPhone (plein écran), la mini-fenêtre PC et le panneau flottant. Il ne lit
 * jamais la base : tout vient de `state`, et le temps affiché est recalculé à chaque seconde depuis les horodatages avec l'horloge
 * injectée (veille, arrière-plan et redémarrage ne le faussent pas).
 */
export function FocusView({ state, variant, clock, onAction, closeRequests = 0, player = null }: FocusViewProps) {
  const now = useNow(clock);
  const { session } = state;
  const record = recordOf(session);
  const [confirming, setConfirming] = useState(false);
  const ended = state.phase === 'ended';

  // F-04 critères 2, 3 et 5 : le son accompagne une fin vécue en direct (le nonce change), jamais une fin passée pendant l'absence de
  // l'app (nonce inchangé à l'ouverture), ni si l'interrupteur est coupé. Le texte et l'anneau portent l'information (critère 10).
  const playedNonce = useRef(state.sound.nonce);
  useEffect(() => {
    if (state.sound.nonce === playedNonce.current) return;
    playedNonce.current = state.sound.nonce;
    if (state.sound.enabled && state.phase === 'ended') void player?.play();
  }, [state.sound.nonce, state.sound.enabled, state.phase, player]);

  // F-01 critère 4 : le terme atteint est signalé une seule fois à la fenêtre principale, qui clôt la session.
  const signalled = useRef<string>('');
  useEffect(() => {
    const key = `${session.id}:${String(session.plannedMin)}:${String(session.pausedSec)}`;
    if (state.phase === 'running' && isElapsed(record, now) && signalled.current !== key) {
      signalled.current = key;
      onAction({ type: 'elapsed' });
    }
  });

  // Croix de la barre de titre (PC) : même confirmation que la croix de l'écran.
  const [seenRequests, setSeenRequests] = useState(closeRequests);
  if (closeRequests !== seenRequests) {
    setSeenRequests(closeRequests);
    if (!ended) setConfirming(true);
  }
  // Session terminée : rien à confirmer, la fenêtre se ferme (la tâche reste inchangée).
  const dismissedRequests = useRef(closeRequests);
  useEffect(() => {
    if (closeRequests === dismissedRequests.current) return;
    dismissedRequests.current = closeRequests;
    if (ended) onAction({ type: 'dismiss' });
  }, [closeRequests, ended, onAction]);

  const paused = state.phase === 'paused';
  // Annonce de l'état (critère 9) : « Session en pause » à la pause, « Session reprise » après une reprise, rien au lancement.
  const [seenPaused, setSeenPaused] = useState(paused);
  if (paused && !seenPaused) setSeenPaused(true);
  const stateAnnouncement = paused ? t('focus.pausedState') : seenPaused ? t('focus.runningState') : '';
  const longPause = paused && isLongPause(record, now);

  // Barre d'espace : pause / reprise quand la mini-fenêtre a le focus (critère 6) ; sur un bouton, l'espace garde son rôle natif.
  useEffect(() => {
    if (variant !== 'window' || ended) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== ' ' || event.repeat || event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('button, a, input, textarea, [role="alertdialog"]')) return;
      event.preventDefault();
      onAction({ type: state.phase === 'paused' ? 'resume' : 'pause' });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [variant, ended, state.phase, onAction]);

  const free = session.plannedMin === null;
  // Session terminée : anneau complet (F-04) ; sinon il se vide avec le temps actif.
  const fraction = ended ? 1 : remainingFraction(record, now);
  const minutes = activeMinutes(record, now);
  const clockText = displayClock(record, now);
  const spaceLine = state.time ? (
    <>
      {t('focus.metaTime', { time: state.time })}
      <span className="ct-focus__space">{state.spaceName}</span>
    </>
  ) : (
    <span className="ct-focus__space">{state.spaceName}</span>
  );
  // Annonce du temps restant toutes les minutes seulement (critère 13), jamais chaque seconde.
  const announce = free
    ? t('focus.announceElapsed', { min: Math.floor(elapsedActiveMs(record, now) / 60_000) })
    : t('focus.announceRemaining', { min: Math.ceil(Math.max(0, session.plannedMin * 60_000 - elapsedActiveMs(record, now)) / 60_000) });

  return (
    <section
      className={`ct-focus ct-focus--${variant}${paused ? ' ct-focus--paused' : ''}${ended ? ' ct-focus--ended' : ''}`}
      aria-label={t('focus.screenLabel')}
      data-phase={state.phase}
    >
      <div className="ct-focus__top">
        <button
          type="button"
          className="ct-focus__iconButton"
          aria-label={t('focus.closeLabel')}
          onClick={() => (ended ? onAction({ type: 'dismiss' }) : setConfirming(true))}
        >
          <Icon icon={X} size={24} strokeWidth={1.8} />
        </button>
        <span className="ct-focus__heading">{t('focus.heading')}</span>
        <span className="ct-focus__spacer" />
      </div>

      <div className="ct-focus__meta">
        <span className="ct-focus__meta-line">{spaceLine}</span>
        <h1 className="ct-focus__title">{state.title ?? t('focus.taskGone')}</h1>
      </div>

      <div className="ct-focus__ring">
        <svg viewBox="0 0 300 300" aria-hidden="true">
          <circle cx="150" cy="150" r="130" fill="none" stroke="var(--ct-focus-track)" strokeWidth="14" />
          <circle
            className="ct-focus__arc"
            cx="150"
            cy="150"
            r="130"
            fill="none"
            stroke={paused ? 'var(--ct-focus-arc-paused)' : 'var(--ct-focus-arc)'}
            strokeWidth="14"
            strokeLinecap="round"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - fraction)}
            transform="rotate(-90 150 150)"
          />
        </svg>
        <div className="ct-focus__readout">
          <span className="ct-focus__time" role="timer" aria-live="off">
            {clockText}
          </span>
          {ended ? (
            <span className="ct-focus__caption" role="alert">
              {t('focus.endedWith', { duration: formatFocusDuration(state.endedMinutes) })}
            </span>
          ) : (
            <span className="ct-focus__caption">{free ? t('focus.elapsed') : t('focus.remainingOn', { min: session.plannedMin })}</span>
          )}
          {paused && <span className="ct-focus__status">{t('focus.pausedSince', { time: formatClock(currentPauseMs(record, now) / 1000) })}</span>}
        </div>
        <span className="ct-visually-hidden" aria-live="polite">
          {ended ? '' : announce}
        </span>
      </div>

      {!ended && (
        <div className="ct-focus__pills" role="group" aria-label={t('focus.durationsLabel')}>
          {FOCUS_DURATIONS_MIN.map((option) => (
            <button
              key={option}
              type="button"
              className="ct-focus__pill"
              aria-pressed={session.plannedMin === option}
              onClick={() => onAction({ type: 'duration', minutes: option })}
            >
              {t('focus.durationOption', { min: option })}
            </button>
          ))}
          <button type="button" className="ct-focus__pill" aria-pressed={free} onClick={() => onAction({ type: 'duration', minutes: null })}>
            {t('focus.durationFree')}
          </button>
        </div>
      )}

      <div className="ct-focus__grow" />
      <span className="ct-visually-hidden" aria-live="polite">
        {stateAnnouncement}
      </span>

      {longPause && (
        <div className="ct-focus__notice" role="group" aria-label={t('focus.stillPausedTitle')}>
          <span>{t('focus.stillPausedTitle')}</span>
          <div className="ct-focus__notice-actions">
            <button type="button" className="ct-focus__link" onClick={() => onAction({ type: 'resume' })}>
              {t('focus.resume')}
            </button>
            <button type="button" className="ct-focus__link" onClick={() => setConfirming(true)}>
              {t('focus.stillPausedStop')}
            </button>
          </div>
        </div>
      )}

      {ended ? (
        <div className="ct-focus__stack">
          {state.canFinishTask && (
            <button type="button" className="ct-focus__button ct-focus__button--finish" onClick={() => onAction({ type: 'finishTask' })}>
              {t('focus.finishTask')}
            </button>
          )}
          {state.canFinishTask && (
            <button type="button" className="ct-focus__button" onClick={() => onAction({ type: 'another' })}>
              {t('focus.another')}
            </button>
          )}
          <button type="button" className="ct-focus__button" onClick={() => onAction({ type: 'dismiss' })}>
            {t('focus.dismiss')}
          </button>
        </div>
      ) : (
        <div className="ct-focus__actions">
          <button
            type="button"
            className={`ct-focus__button${paused ? ' ct-focus__button--resume' : ''}`}
            aria-label={paused ? t('focus.resumeLabel') : t('focus.pauseLabel')}
            onClick={() => onAction({ type: paused ? 'resume' : 'pause' })}
          >
            {paused ? t('focus.resume') : t('focus.pause')}
          </button>
          {state.canFinishTask && (
            <button type="button" className="ct-focus__button ct-focus__button--finish" onClick={() => onAction({ type: 'finishTask' })}>
              {t('focus.finishTask')}
            </button>
          )}
        </div>
      )}

      {confirming && (
        <StopConfirm
          minutes={minutes}
          onStop={() => {
            setConfirming(false);
            onAction({ type: 'stop' });
          }}
          onContinue={() => setConfirming(false)}
        />
      )}
    </section>
  );
}

/** « Arrêter la session ? » (F-01 critère 7) : « Arrêter et enregistrer N min » ou, sous une minute, arrêt sans trace. */
function StopConfirm({ minutes, onStop, onContinue }: { minutes: number; onStop: () => void; onContinue: () => void }) {
  const ref = useFocusTrap<HTMLDivElement>({ active: true, onEscape: onContinue });
  return (
    <div className="ct-focus__backdrop">
      <div ref={ref} role="alertdialog" aria-modal="true" aria-label={t('focus.stopTitle')} tabIndex={-1} className="ct-focus__dialog">
        <h2>{t('focus.stopTitle')}</h2>
        {minutes < 1 && <p>{t('focus.stopDiscardHint')}</p>}
        <button type="button" className="ct-focus__button ct-focus__button--finish" onClick={onStop}>
          {minutes < 1 ? t('focus.stopDiscard') : t('focus.stopSave', { min: minutes })}
        </button>
        <button type="button" className="ct-focus__button" onClick={onContinue}>
          {t('focus.stopContinue')}
        </button>
      </div>
    </div>
  );
}
