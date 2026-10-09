import { useState } from 'react';
import { t } from '../../i18n';
import { tUpdateRestore } from '../../i18n/appUpdateRestoreText';
import { ConfirmDialog } from '../../ui';
import type { UpdateRestoreOutcome } from './updateRestore';

type RestoreState = { readonly phase: 'idle' | 'confirm' | 'running' } | { readonly phase: 'failed'; readonly message: string; readonly code: string };

export interface UpdateRestoreActionProps {
  /** Nom de la sauvegarde « Avant mise à jour » de ce démarrage (jamais un chemin). */
  readonly name: string;
  readonly restore: (name: string) => Promise<UpdateRestoreOutcome>;
}

/**
 * I-06 (ADR 0007 avenant I-06 point 7) : troisième action de l'écran d'échec, chargée à la demande (bundle de départ) : « Restaurer la
 * sauvegarde d'avant la mise à jour », confirmation (« Annuler » par défaut), annonce pendant l'opération ; un échec affiche la raison de
 * P-04 et son code, l'écran reste et l'action peut être relancée. Réussite : l'app redémarre (relance ou rechargement).
 */
export function UpdateRestoreAction({ name, restore }: UpdateRestoreActionProps) {
  const [state, setState] = useState<RestoreState>({ phase: 'idle' });

  const run = async () => {
    setState({ phase: 'running' });
    const outcome = await restore(name).catch((): UpdateRestoreOutcome => ({ ok: false, message: t('backup.errorIo'), code: 'io' }));
    if (!outcome.ok) setState({ phase: 'failed', message: outcome.message, code: outcome.code });
  };

  return (
    <>
      <button type="button" disabled={state.phase === 'running'} onClick={() => setState({ phase: 'confirm' })}>
        {tUpdateRestore('restore')}
      </button>
      {state.phase === 'running' && (
        <p role="status" className="ct-db-failure__note">
          {tUpdateRestore('restoring')}
        </p>
      )}
      {state.phase === 'failed' && (
        <p role="alert" className="ct-db-failure__note">
          {tUpdateRestore('restoreFailed', { reason: state.message })} {t('backup.errorCode', { code: state.code })}
        </p>
      )}
      {state.phase === 'confirm' && (
        <ConfirmDialog
          title={tUpdateRestore('restoreConfirmTitle')}
          description={tUpdateRestore('restoreConfirmBody')}
          confirmLabel={tUpdateRestore('restoreConfirm')}
          onConfirm={() => void run()}
          onCancel={() => setState({ phase: 'idle' })}
        />
      )}
    </>
  );
}
