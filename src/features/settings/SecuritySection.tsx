import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import type { BiometricStatus } from '../../platform/biometric';
import { Switch } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { useAppLockStore, type AppLockState } from '../security/appLockStore';

function rowLabel(status: BiometricStatus | null): string {
  if (status?.biometryAvailable && status.kind === 'face-id') return t('security.settings.rowFaceId');
  if (status?.biometryAvailable) return t('security.settings.rowBiometry');
  // Biométrie indisponible (refusée, non configurée) : le code de l'iPhone suffit (critère 9). État inconnu : libellé de la maquette.
  if (status && status.code !== null && status.code !== 'unavailable' && status.code !== 'unknown' && status.passcode !== 'not-set') return t('security.settings.rowPasscode');
  return t('security.settings.rowFaceId');
}

function settingsMessageText(message: NonNullable<AppLockState['settingsMessage']>): string[] {
  const lines = [t(message.main === 'notEnabled' ? 'security.settings.notEnabled' : 'security.settings.notDisabled')];
  if (message.detail === 'noPasscode') lines.push(t('security.settings.noPasscode'));
  if (message.detail === 'unsupported') lines.push(t('security.settings.unsupported', { code: message.code ?? 'unknown' }));
  if (message.detail === 'saveFailed') lines.push(t('security.settings.saveFailed'));
  return lines;
}

/**
 * Ligne « Verrouillage Face ID » de DONNÉES ET SÉCURITÉ (Reglages.html, I-03 D2) : iPhone seulement (absente si l'authentification n'est pas
 * prise en charge). Activer ou désactiver exige une authentification réussie ; un refus laisse le réglage inchangé avec un message visible.
 * Libellé selon `status` (figé au lancement, constat 4) : jamais une décision de sécurité.
 */
export function SecuritySection() {
  const container = useAppContainer();
  const enabled = useAppLockStore((s) => s.enabled);
  const busy = useAppLockStore((s) => s.busy);
  const actions = useAppLockStore((s) => s.actions);
  const message = useAppLockStore((s) => s.settingsMessage);
  const shieldFailure = useAppLockStore((s) => s.shieldFailure);
  const [status, setStatus] = useState<BiometricStatus | null>(null);
  const supported = container.authenticator.supported;

  useEffect(() => {
    if (!supported) return undefined;
    let live = true;
    void container.authenticator.status().then((value) => {
      if (live) setStatus(value);
    });
    return () => {
      live = false;
    };
  }, [container, supported]);

  if (!supported) return null;
  const label = rowLabel(status);
  return (
    <>
      <div className="ct-settings__row">
        <span className="ct-settings__stack">
          {label}
          <span className="ct-settings__hint">{t('security.settings.fallback')}</span>
        </span>
        <Switch checked={enabled} label={label} disabled={busy || actions === null} onChange={(value) => void (value ? actions?.enable() : actions?.disable())} />
      </div>
      {message && (
        <p className="ct-settings__error" role="alert">
          {settingsMessageText(message).join(' ')}
        </p>
      )}
      {enabled && shieldFailure && (
        <p className="ct-settings__error" role="alert">
          {t('security.settings.shieldFailed', { code: shieldFailure })}
        </p>
      )}
      <p className="ct-settings__hint">
        {t('security.settings.relockNote')} {t('security.settings.notificationsNote')}
      </p>
    </>
  );
}
