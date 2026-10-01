import { useEffect, useRef } from 'react';
import { t } from '../i18n';
import './Toast.css';

export interface ToastProps {
  /** Message d'état déjà résolu par l'appelant (ex. « Tâche reportée »), T-13. */
  message: string;
  /** Libellé du bouton ; « Annuler » (`undo.action`) par défaut. */
  actionLabel?: string;
  onAction: () => void;
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
 *
 * @example
 * <Toast message={t('undo.postpone')} onAction={undoLast} onTimeout={dismiss} resetKey={snapshot.pushCount} />
 */
export function Toast({ message, actionLabel, onAction, onTimeout, durationMs = DEFAULT_DURATION_MS, resetKey, className }: ToastProps) {
  const onTimeoutRef = useRef(onTimeout);
  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  }, [onTimeout]);

  useEffect(() => {
    const id = setTimeout(() => onTimeoutRef.current?.(), durationMs);
    return () => clearTimeout(id);
  }, [durationMs, resetKey, message]);

  return (
    <div role="status" className={['ct-toast', className].filter(Boolean).join(' ')}>
      <div key={`${String(resetKey)}-${message}`} className="ct-toast__bar" style={{ animationDuration: `${durationMs}ms` }} />
      <span className="ct-toast__message">{message}</span>
      <button type="button" onClick={onAction} className="ct-toast__action">
        {actionLabel ?? t('undo.action')}
      </button>
    </div>
  );
}
