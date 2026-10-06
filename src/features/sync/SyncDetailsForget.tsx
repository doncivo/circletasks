import { useState } from 'react';
import { t } from '../../i18n';
import { relaunchApp } from '../../platform/relaunch';
import type { SyncDeviceStatus } from '../../platform/sync/types';
import { Button, ConfirmDialog } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { ForgetDeviceDialog } from './ForgetDeviceDialog';
import { syncStore } from './syncStore';
import './SyncDetailsForget.css';
import { forgetDeletionLine, forgetDeviceName, forgetFailureText } from './forgetText';
import { deviceName, formatSyncTime } from './syncText';

/**
 * Y-10 « J'oublie un appareil » dans Réglages › Synchronisation › Détails (aucune maquette : composé avec les lignes de Réglages, les
 * boutons et `ConfirmDialog` existants ; décision d'Ali du 2026-10-05). Tous les états sont annoncés (`role="status"`), jamais de boîte
 * bloquante ; les textes sont dans `src/i18n` (`sync.forget`).
 */

/** Relance de l'app après « Associer de nouveau » : processus relancé dans l'app installée, page rechargée ailleurs (dev, Playwright). */
function defaultRelaunch(runtime: string): Promise<void> {
  if (runtime === 'tauri') return relaunchApp();
  window.location.reload();
  return Promise.resolve();
}

/**
 * Emplacement `forget` (critères 15 a, 16, 17) : échec persistant d'un oubli, d'une suppression ou d'une association (rouge,
 * `role="status"`, « Réessayer », effacé seulement à la réussite) ; appareil local oublié : « Cet appareil a été oublié : associez-le de
 * nouveau » et « Associer de nouveau » (confirmation, puis dossier délié, nouvel identifiant, choix du dossier, relance).
 */
export function SyncDetailsForget({ relaunch }: { readonly relaunch?: () => Promise<void> } = {}) {
  const container = useAppContainer();
  const status = useFeatureStore(syncStore, (s) => s.status);
  const [confirmRejoin, setConfirmRejoin] = useState(false);
  const [busy, setBusy] = useState(false);
  const failure = status.forget?.failure ?? null;
  const forgotten = status.phase === 'forgotten';
  const sync = container.sync;
  if (!sync || (!failure && !forgotten)) return null;

  const rejoin = async (): Promise<void> => {
    setConfirmRejoin(false);
    setBusy(true);
    try {
      const outcome = await sync.rejoin();
      if (outcome.kind !== 'restart') return;
      // Dossier délié : choisi de nouveau tout de suite (boîte système) ; annulé, il le sera depuis Réglages après la relance.
      await container.syncPlatform?.folder.choose().catch(() => null);
      await (relaunch ?? (() => defaultRelaunch(container.platform.runtime)))();
    } finally {
      setBusy(false);
    }
  };

  const retry = async (): Promise<void> => {
    if (!failure) return;
    setBusy(true);
    try {
      if (failure.step === 'declare') await sync.forgetDevice(failure.deviceId);
      else if (failure.step === 'rejoin') await rejoin();
      else await sync.syncNow('manual');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="ct-settings__section">{t('sync.forget.section')}</h2>
      <div role="status" className="ct-sync__forget">
        {forgotten && (
          <div className="ct-settings__row ct-sync__device" data-forgotten-self="true">
            <span className="ct-sync__forgetText" data-trouble="true">
              {t('sync.forget.selfForgotten')}
            </span>
            <span className="ct-sync__deviceRead">{t('sync.forget.selfForgottenDetail')}</span>
            <Button variant="secondary" ariaLabel={t('sync.forget.rejoinLabel')} onClick={() => setConfirmRejoin(true)} disabled={busy} ariaBusy={busy} className="ct-settings__link">
              {busy ? t('sync.forget.rejoinRunning') : t('sync.forget.rejoin')}
            </Button>
          </div>
        )}
        {failure && (
          <div className="ct-settings__row ct-sync__device" data-failed="true">
            <span className="ct-sync__forgetText" data-trouble="true">
              {forgetFailureText(failure, status.devices)}
            </span>
            <span className="ct-sync__deviceRead">{t('sync.forget.failedAt', { time: formatSyncTime(failure.at, container.clock.nowMs()) })}</span>
            <Button
              variant="secondary"
              ariaLabel={failure.step === 'declare' ? t('sync.forget.retryDeclareLabel', { device: forgetDeviceName(failure.deviceId, status.devices) }) : t('sync.forget.retrySyncLabel')}
              onClick={() => void retry()}
              disabled={busy}
              ariaBusy={busy}
              className="ct-settings__link"
            >
              {t('sync.forget.retry')}
            </Button>
          </div>
        )}
      </div>
      {confirmRejoin && (
        <ConfirmDialog title={t('sync.forget.rejoinTitle')} description={t('sync.forget.rejoinBody')} confirmLabel={t('sync.forget.rejoin')} onConfirm={() => void rejoin()} onCancel={() => setConfirmRejoin(false)} />
      )}
    </>
  );
}

/**
 * Action de la ligne d'un **autre** appareil dans APPAREILS (critères 1, 2, 3, 13) : « Oublier cet appareil » (boîte de l'app, puis
 * confirmation native de Rust) ; appareil oublié : « Oublié » (libellé de la ligne) et, tant que ses fichiers restent, « suppression des
 * fichiers en attente de {appareil} », sans bouton. Jamais rendue pour l'appareil local, ni quand cet appareil est lui-même oublié.
 */
export function SyncDeviceForgetAction({ device }: { readonly device: SyncDeviceStatus }) {
  const container = useAppContainer();
  const status = useFeatureStore(syncStore, (s) => s.status);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const sync = container.sync;
  if (device.self || !sync) return null;
  const name = deviceName(device, status.devices);

  if (device.status === 'forgotten') {
    const text = forgetDeletionLine(status.forget?.deletions.find((d) => d.deviceId === device.deviceId), status.devices);
    return text ? (
      <span role="status" className="ct-sync__deviceRead ct-sync__forgetLine">
        {text}
      </span>
    ) : null;
  }
  if (status.phase === 'forgotten' || status.phase === 'not-configured' || status.phase === 'needs-pairing') return null;

  const forget = async (): Promise<void> => {
    setOpen(false);
    setBusy(true);
    setNotice(t('sync.forget.pending', { device: name }));
    try {
      const outcome = await sync.forgetDevice(device.deviceId);
      // Échec : gardé et affiché dans l'emplacement `forget` (rouge, « Réessayer »).
      setNotice(outcome.kind === 'cancelled' ? t('sync.forget.cancelled') : outcome.kind === 'done' ? t('sync.forget.done', { device: name }) : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="secondary" ariaLabel={t('sync.forget.actionLabel', { device: name })} onClick={() => setOpen(true)} disabled={busy} ariaBusy={busy} className="ct-settings__link">
        {t('sync.forget.action')}
      </Button>
      {notice && (
        <span role="status" className="ct-sync__deviceRead">
          {notice}
        </span>
      )}
      {open && <ForgetDeviceDialog deviceName={name} onContinue={() => void forget()} onCancel={() => setOpen(false)} />}
    </>
  );
}
