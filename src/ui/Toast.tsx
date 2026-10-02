import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import './Toast.css';

export interface ToastProps {
  /** Message d'état déjà résolu par l'appelant (ex. « Tâche reportée »), T-13. */
  message: string;
  /** Libellé du bouton ; « Annuler » (`undo.action`) par défaut. */
  actionLabel?: string;
  /** Action du bouton ; sans elle, le bandeau n'affiche que le message (ex. « Action impossible à annuler »). */
  onAction?: () => void;
  /** Appelé quand le délai s'écoule sans action de l'utilisateur. */
  onTimeout?: () => void;
  /** Durée d'affichage ; 5 s par défaut (`UNDO_TOAST_MS`, src/features/app/undo.ts). */
  durationMs?: number;
  /** Change à chaque nouvelle action empilée (ex. `pushCount`) : relance le compte à rebours. */
  resetKey?: number | string;
  className?: string;
}

const DEFAULT_DURATION_MS = 5_000;

/**
 * Bandeau « Annuler » 5 s (A-09, T-13) : barre de compte à rebours (animation,
 * neutralisée par `prefers-reduced-motion`, règle globale de tokens.css),
 * bouton d'action, `role="status"` pour une annonce non bloquante.
 * Le délai est suspendu tant que le bandeau est survolé ou contient le focus (WCAG 2.2.1) :
 * il reprend avec le temps restant ensuite.
 *
 * @example
 * <Toast message={t('undo.postpone')} onAction={undoLast} onTimeout={dismiss} resetKey={snapshot.pushCount} />
 */
export function Toast({ message, actionLabel, onAction, onTimeout, durationMs = DEFAULT_DURATION_MS, resetKey, className }: ToastProps) {
  const onTimeoutRef = useRef(onTimeout);
  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  }, [onTimeout]);

  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const remaining = useRef(durationMs);
  const startedAt = useRef(0);

  // Nouveau message ou nouvelle action empilée : le délai repart de la durée complète.
  useEffect(() => {
    remaining.current = durationMs;
  }, [durationMs, resetKey, message]);

  useEffect(() => {
    if (paused) return undefined;
    startedAt.current = Date.now();
    const id = setTimeout(() => onTimeoutRef.current?.(), remaining.current);
    return () => {
      clearTimeout(id);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    };
  }, [paused, durationMs, resetKey, message]);

  return (
    <div
      role="status"
      className={['ct-toast', className].filter(Boolean).join(' ')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div
        key={`${String(resetKey)}-${message}`}
        className="ct-toast__bar"
        style={{ animationDuration: `${durationMs}ms`, animationPlayState: paused ? 'paused' : 'running' }}
      />
      <span className="ct-toast__message">{message}</span>
      {onAction && (
        <button type="button" onClick={onAction} className="ct-toast__action">
          {actionLabel ?? t('undo.action')}
        </button>
      )}
    </div>
  );
}
