import { useState } from 'react';
import type { DeviceId } from '../../domain/types';
import { t, type PlainMessageKey } from '../../i18n';
import type { SyncDeviceStatus, SyncResetStatus } from '../../platform/sync/types';
import { Button } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { forgetDeviceName } from './forgetText';
import { openPairingWindow, pairingOpenErrorKey } from './pairingStatus';
import { ResetSyncDialog } from './ResetSyncDialog';
import { resetFailureText, resetReminderText, resetStepText } from './resetText';
import { SyncDeviceForgetAction } from './SyncDetailsForget';
import { syncStore } from './syncStore';
import { formatSyncTime, resetRequiredLine } from './syncText';

/**
 * Emplacement « réinitialiser la synchronisation » de Réglages › Synchronisation › Détails (Y-11 critères 1, 7, 13, 17 et 19 ; aucune
 * maquette : composé avec les lignes de Réglages, les boutons, `ConfirmDialog` et la fenêtre `pairing` existants, décision d'Ali du
 * 2026-10-05). Tous les états sont annoncés (`role="status"`), jamais de boîte bloquante ; les textes sont dans `src/i18n` (`sync.reset`).
 *
 * - Bouton « Réinitialiser la synchronisation » : boîte de l'app (`ResetSyncDialog`), puis confirmation native de Rust.
 * - Étape en cours en clair, échec en rouge avec « Réessayer » (gardé jusqu'à sa résolution, même après un redémarrage), reprise après
 *   un arrêt dite ; appareils pas encore associés (nom, dernière synchronisation) avec « Oublier cet appareil » de Y-10 (seul moyen de
 *   terminer sans eux) ; rappel des 30 jours ; nouvelle clé de secours (fenêtre `pairing`, instance `show` : elle porte K2).
 * - Cet appareil à associer de nouveau (annonce authentique, ou perte d'une réinitialisation simultanée) : texte et explication ;
 *   « Associer cet appareil » est dans l'emplacement `pairing`.
 */

type Notice = { readonly text: string; readonly tone: 'ok' | 'danger'; readonly syncFirst?: boolean };

const IN_PROGRESS: ReadonlySet<SyncResetStatus['step']> = new Set(['announced', 'snapshot', 'waiting-devices', 'switching', 'joined']);

export function SyncDetailsReset() {
  const container = useAppContainer();
  const status = useFeatureStore(syncStore, (s) => s.status);
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [keyNotice, setKeyNotice] = useState<PlainMessageKey | null>(null);
  const sync = container.sync;
  if (!sync || !container.syncPlatform) return null;
  const reset = status.reset ?? null;
  const phase = status.phase;
  const required = phase === 'reset-required' || reset?.role === 'required' || reset?.step === 'superseded';
  const configured = phase !== 'not-configured' && phase !== 'needs-pairing' && phase !== 'key-mismatch' && phase !== 'forgotten';
  const running = reset !== null && IN_PROGRESS.has(reset.step);
  const canStart = configured && !required && !running;
  if (!configured && !required && !reset) return null;
  const nowMs = container.clock.nowMs();
  const devices = status.devices;

  const start = async (): Promise<void> => {
    setDialog(false);
    setBusy(true);
    setNotice({ text: t('sync.reset.running'), tone: 'ok' });
    try {
      const outcome = await sync.resetSync();
      switch (outcome.kind) {
        case 'cancelled':
          setNotice({ text: t('sync.reset.cancelled'), tone: 'ok' });
          break;
        case 'lagging':
          setNotice({ text: outcome.device ? t('sync.reset.lagging', { device: forgetDeviceName(outcome.device, devices) }) : t('sync.reset.laggingUnknown'), tone: 'danger', syncFirst: true });
          break;
        case 'failed':
          setNotice({ text: resetFailureText({ code: outcome.code, step: 'start' }), tone: 'danger' });
          break;
        case 'started':
          setNotice({ text: t('sync.reset.started'), tone: 'ok' });
          break;
      }
    } finally {
      setBusy(false);
    }
  };

  const showRecovery = async (): Promise<void> => {
    setKeyNotice(null);
    const code = await openPairingWindow(container, 'show');
    if (code) setKeyNotice(pairingOpenErrorKey(code, 'show'));
  };

  const retry = async (): Promise<void> => {
    if (reset?.failure?.step === 'start') {
      setDialog(true);
      return;
    }
    setBusy(true);
    try {
      await sync.syncNow('manual');
    } finally {
      setBusy(false);
    }
  };

  const syncFirst = async (): Promise<void> => {
    setBusy(true);
    try {
      await sync.syncNow('manual');
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const waiting = reset?.role === 'initiator' && reset.step === 'waiting-devices' ? reset.waiting : [];
  const showKey = reset !== null && reset.role === 'initiator' && (running || reset.step === 'done');

  return (
    <>
      <h2 className="ct-settings__section">{t('sync.reset.section')}</h2>
      <div role="status" className="ct-sync__reset" data-testid="sync-reset">
        {required && (
          <div className="ct-settings__row ct-sync__device" data-reset-required="true">
            <span className="ct-settings__stack">
              <span className="ct-sync__forgetText" data-trouble="true">
                {resetRequiredLine(reset, devices)}
              </span>
              {!reset?.superseded && (
                <span className="ct-settings__hint">{reset?.by ? t('sync.reset.requiredDetail', { device: forgetDeviceName(reset.by, devices) }) : t('sync.reset.requiredDetailUnknown')}</span>
              )}
            </span>
          </div>
        )}
        {reset && !required && (reset.step !== 'start' || reset.failure === null) && (
          <div className="ct-settings__row ct-sync__device" data-reset-step={reset.step}>
            <span className="ct-settings__stack">
              <span className="ct-sync__forgetText">{resetStepText(reset, devices)}</span>
              {reset.resumed && reset.step !== 'done' && <span className="ct-settings__hint">{t('sync.reset.steps.resumed')}</span>}
            </span>
            {reset.step === 'done' && (
              <Button variant="secondary" ariaLabel={t('sync.reset.dismissLabel')} onClick={() => void sync.dismissReset()} className="ct-settings__link">
                {t('sync.reset.dismiss')}
              </Button>
            )}
          </div>
        )}
        {reset?.failure && (
          <div className="ct-settings__row ct-sync__device" data-failed="true">
            <span className="ct-settings__stack">
              <span className="ct-sync__forgetText" data-trouble="true">
                {resetFailureText(reset.failure)}
              </span>
              <span className="ct-settings__hint">{t('sync.reset.failedAt', { time: formatSyncTime(reset.failure.at, nowMs) })}</span>
            </span>
            <Button variant="secondary" ariaLabel={t('sync.reset.retryLabel')} onClick={() => void retry()} disabled={busy} ariaBusy={busy} className="ct-settings__link">
              {t('sync.reset.retry')}
            </Button>
            {reset.step === 'start' && (
              <Button variant="secondary" ariaLabel={t('sync.reset.dismissLabel')} onClick={() => void sync.dismissReset()} className="ct-settings__link">
                {t('sync.reset.dismiss')}
              </Button>
            )}
          </div>
        )}
        {reset?.reminder && (
          <div className="ct-settings__row" data-reminder="true">
            <span className="ct-sync__forgetText" data-trouble="true">
              {resetReminderText(reset.waiting, devices)}
            </span>
          </div>
        )}
        {canStart && (
          <div className="ct-settings__row">
            <span className="ct-settings__stack">
              {t('sync.reset.action')}
              <span className="ct-settings__hint">{t('sync.reset.actionHint')}</span>
            </span>
            <Button variant="secondary" ariaLabel={t('sync.reset.actionLabel')} onClick={() => setDialog(true)} disabled={busy} ariaBusy={busy} className="ct-settings__link">
              {busy ? t('sync.reset.running') : t('sync.reset.action')}
            </Button>
          </div>
        )}
        {notice && (
          <div className="ct-settings__row">
            <span className={notice.tone === 'ok' ? 'ct-settings__hint ct-sync__ok' : 'ct-settings__hint ct-settings__hint--danger'} data-testid="sync-reset-notice">
              {notice.text}
            </span>
            {notice.syncFirst && (
              <Button variant="secondary" ariaLabel={t('sync.reset.syncFirstLabel')} onClick={() => void syncFirst()} disabled={busy} className="ct-settings__link">
                {t('sync.reset.syncFirst')}
              </Button>
            )}
          </div>
        )}
      </div>
      {waiting.length > 0 && <WaitingDevices waiting={waiting} devices={devices} nowMs={nowMs} />}
      {showKey && (
        <>
          <h2 className="ct-settings__section">{t('sync.reset.recoveryTitle')}</h2>
          <div className="ct-settings__row">
            <span className="ct-settings__stack">
              {t('sync.reset.recoveryBody')}
              {keyNotice && (
                <span className="ct-settings__hint ct-settings__hint--danger" role="status">
                  {t(keyNotice)}
                </span>
              )}
            </span>
            <Button variant="secondary" ariaLabel={t('sync.reset.recoveryActionLabel')} onClick={() => void showRecovery()} className="ct-settings__link">
              {t('sync.reset.recoveryAction')}
            </Button>
          </div>
        </>
      )}
      {dialog && <ResetSyncDialog onContinue={() => void start()} onCancel={() => setDialog(false)} />}
    </>
  );
}

/** Appareils pas encore associés (critère 13) : nom comme dans APPAREILS, dernière synchronisation, « Oublier cet appareil » (Y-10). */
function WaitingDevices({ waiting, devices, nowMs }: { readonly waiting: readonly DeviceId[]; readonly devices: readonly SyncDeviceStatus[]; readonly nowMs: number }) {
  return (
    <>
      <h2 className="ct-settings__section">{t('sync.reset.waitingTitle')}</h2>
      <p className="ct-settings__hint">{t('sync.reset.waitingHint')}</p>
      <ul className="ct-sync__devices" data-testid="sync-reset-waiting">
        {waiting.map((id) => {
          const device: SyncDeviceStatus = devices.find((d) => d.deviceId === id) ?? { deviceId: id, platform: 'windows', self: false, lastReadAt: null, status: 'active', seen: false };
          return (
            <li key={id} className="ct-settings__row ct-sync__device">
              <span className="ct-sync__deviceName">{forgetDeviceName(id, devices)}</span>
              <span className="ct-sync__deviceRead">{device.lastReadAt ? t('sync.reset.waitingLastSync', { time: formatSyncTime(device.lastReadAt, nowMs) }) : t('sync.reset.waitingNever')}</span>
              <SyncDeviceForgetAction device={device} />
            </li>
          );
        })}
      </ul>
    </>
  );
}
