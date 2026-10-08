import { LockKeyhole } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../i18n';
import { Button, ConfirmDialog, Icon } from '../../ui';
import { useAppLockStore, type LockMessage } from './appLockStore';
import { ensureLockLayer } from './startAppLock';

function messageText(message: LockMessage): string {
  switch (message.kind) {
    case 'cancelled':
      return t('security.lock.cancelled');
    case 'failed':
      return t('security.lock.failed', { code: message.code });
    case 'no-passcode':
      return t('security.lock.noPasscode');
    case 'plugin':
      return t('security.lock.pluginFailed', { code: message.code });
    case 'setting-unreadable':
      return t('security.lock.settingUnreadable');
    case 'disable-failed':
      return t('security.lock.disableFailed');
  }
}

/**
 * Écran de verrou (I-03 critères 6, 9 et 11) : écran sans maquette, composé avec les composants existants (icône Lucide au trait, titre,
 * bouton primaire, confirmation T-08). Seul contenu lisible pendant le verrou : rendu dans la couche `#ct-lock-layer`, hors de `#root`
 * (masqué). Message d'échec annoncé (`role="alert"`) ; aucune limite d'essais côté app (iOS gère limites et repli sur le code).
 */
export function LockScreen() {
  const actions = useAppLockStore((s) => s.actions);
  const busy = useAppLockStore((s) => s.busy);
  const message = useAppLockStore((s) => s.message);
  const noPasscodeExit = useAppLockStore((s) => s.noPasscodeExit);
  const [confirming, setConfirming] = useState(false);

  // Une authentification automatique par épisode de verrou (le contrôleur la garde unique).
  useEffect(() => actions?.requestAutoUnlock(), [actions]);

  const retry = message?.kind === 'plugin';
  const screen = (
    <main className="ct-lock" aria-labelledby="ct-lock-title">
      <span className="ct-lock__badge">
        <Icon icon={LockKeyhole} size={30} />
      </span>
      <p className="ct-lock__app">{t('app.name')}</p>
      <h1 id="ct-lock-title" className="ct-lock__title">
        {t('security.lock.title')}
      </h1>
      {message && (
        <p className="ct-lock__message" role="alert">
          {messageText(message)}
        </p>
      )}
      <div className="ct-lock__actions">
        <Button fullWidth {...(retry ? {} : { ariaLabel: t('security.lock.unlockLabel') })} disabled={busy} ariaBusy={busy} onClick={() => void actions?.unlock()}>
          {retry ? t('security.lock.retry') : t('security.lock.unlock')}
        </Button>
        {noPasscodeExit && (
          <Button variant="secondary" fullWidth disabled={busy} onClick={() => setConfirming(true)}>
            {t('security.lock.disable')}
          </Button>
        )}
      </div>
      {confirming && (
        <ConfirmDialog
          title={t('security.lock.disableConfirmTitle')}
          description={t('security.lock.disableConfirmText')}
          confirmLabel={t('security.lock.disableConfirm')}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void actions?.disableWithoutPasscode();
          }}
        />
      )}
    </main>
  );
  return createPortal(screen, ensureLockLayer());
}
