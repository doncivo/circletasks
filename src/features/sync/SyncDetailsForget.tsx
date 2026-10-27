import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { relaunchApp } from '../../platform/relaunch';
import type { DeviceId, IsoDateTime } from '../../domain/types';
import type { CancelForgetOutcome, SyncDeviceStatus } from '../../platform/sync/types';
import { Button, ConfirmDialog } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { ForgetDeviceDialog } from './ForgetDeviceDialog';
import { syncStore } from './syncStore';
import './SyncDetailsForget.css';
import { cancelForgetText, forgetDeletionLine, forgetDeviceName, forgetFailureText } from './forgetText';
import { deviceName, formatSyncTime } from './syncText';
import { withExcursion } from '../security/excursion';

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
 *
 * Y-10-FIX-01 (consigne d'Ali : une action destructrice ne part jamais sans accord explicite) : échec à l'étape `declare` seulement,
 * « Annuler la demande » à côté de « Réessayer » (mémo effacé, rien d'autre) ; « Réessayer » y repasse par `ForgetDeviceDialog` avant la
 * confirmation native (D1). Seuls les boutons agissent : la ligne et son texte n'ont aucun gestionnaire.
 */
export function SyncDetailsForget({ relaunch }: { readonly relaunch?: () => Promise<void> } = {}) {
  const container = useAppContainer();
  const status = useFeatureStore(syncStore, (s) => s.status);
  const [confirmRejoin, setConfirmRejoin] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Oubli à confirmer de nouveau dans la boîte de l'app (« Réessayer » à l'étape `declare`, D1). */
  const [confirmForget, setConfirmForget] = useState<DeviceId | null>(null);
  /** Issue de « Annuler la demande » et heure de l'échec visé (un échec plus récent la rend caduque). */
  const [cancelNotice, setCancelNotice] = useState<{ readonly outcome: CancelForgetOutcome; readonly at: IsoDateTime } | null>(null);
  const region = useRef<HTMLDivElement>(null);
  // Critère 11 : la ligne disparue (avec le bouton qui avait le focus), le focus va à la zone de statut, jamais perdu sur la page.
  useEffect(() => {
    if (cancelNotice) region.current?.focus();
  }, [cancelNotice]);
  const failure = status.forget?.failure ?? null;
  const forgotten = status.phase === 'forgotten';
  const sync = container.sync;
  // « Demande annulée » tant qu'aucun nouvel échec n'est affiché ; annulation refusée : tant que l'échec visé reste affiché.
  const notice = cancelNotice && (cancelNotice.outcome.kind === 'failed' ? failure?.at === cancelNotice.at : failure === null) ? cancelNotice.outcome : null;
  // Pendant une action (annulation en cours), la zone reste montée : l'échec effacé avant l'arrivée du message ne la fait pas disparaître.
  if (!sync || (!failure && !forgotten && !notice && !busy)) return null;

  const rejoin = async (): Promise<void> => {
    setConfirmRejoin(false);
    setBusy(true);
    try {
      const outcome = await sync.rejoin();
      if (outcome.kind !== 'restart') return;
      // Dossier délié : choisi de nouveau tout de suite (boîte système) ; annulé, il le sera depuis Réglages après la relance.
      const platform = container.syncPlatform;
      if (platform) await withExcursion('folder-picker', () => platform.folder.choose()).catch(() => null);
      await (relaunch ?? (() => defaultRelaunch(container.platform.runtime)))();
    } finally {
      setBusy(false);
    }
  };

  const retry = async (): Promise<void> => {
    if (!failure) return;
    setCancelNotice(null);
    // D1 : l'oubli n'est jamais relancé sans repasser par la boîte de l'app (texte long, « Annuler » par défaut).
    if (failure.step === 'declare') {
      setConfirmForget(failure.deviceId);
      return;
    }
    setBusy(true);
    try {
      if (failure.step === 'rejoin') await rejoin();
      else await sync.syncNow('manual');
    } finally {
      setBusy(false);
    }
  };

  const forgetAgain = async (deviceId: DeviceId): Promise<void> => {
    setConfirmForget(null);
    setBusy(true);
    try {
      await sync.forgetDevice(deviceId);
    } finally {
      setBusy(false);
    }
  };

  const cancelRequest = async (): Promise<void> => {
    if (failure?.step !== 'declare') return;
    const target = failure;
    setBusy(true);
    try {
      const outcome = await sync.cancelForgetRequest(target.deviceId);
      setCancelNotice({ outcome, at: target.at });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="ct-settings__section">{t('sync.forget.section')}</h2>
      <div role="status" className="ct-sync__forget" ref={region} tabIndex={-1}>
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
            {failure.step === 'declare' && (
              <Button
                variant="secondary"
                ariaLabel={t('sync.forget.cancelRequestLabel', { device: forgetDeviceName(failure.deviceId, status.devices) })}
                onClick={() => void cancelRequest()}
                disabled={busy}
                ariaBusy={busy}
                className="ct-settings__link"
              >
                {t('sync.forget.cancelRequest')}
              </Button>
            )}
          </div>
        )}
        {notice && (
          <span className={notice.kind === 'failed' ? 'ct-sync__forgetText' : 'ct-sync__deviceRead'} data-cancel-notice={notice.kind} data-trouble={notice.kind === 'failed' ? 'true' : undefined}>
            {cancelForgetText(notice)}
          </span>
        )}
      </div>
      {confirmForget && (
        <ForgetDeviceDialog deviceName={forgetDeviceName(confirmForget, status.devices)} onContinue={() => void forgetAgain(confirmForget)} onCancel={() => setConfirmForget(null)} />
      )}
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
  /**
   * Message de la ligne ; `storedAt` : heure de l'échec gardé dans `sync_meta` qu'il répète (Y-10-FIX-01 : effacé par « Annuler la
   * demande » ou remplacé, il n'est plus répété ici) ; null : rien de gardé, le message reste (seul endroit où l'échec est dit).
   */
  const [notice, setNotice] = useState<{ readonly text: string; readonly storedAt: string | null } | null>(null);
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
    setNotice({ text: t('sync.forget.pending', { device: name }), storedAt: null });
    try {
      const outcome = await sync.forgetDevice(device.deviceId);
      // Échec : gardé et affiché dans l'emplacement `forget` (rouge, « Réessayer ») ; dit aussi ici, au cas où il n'aurait pas pu être
      // gardé (revue Y-10, suggestion 9). Réussite : la parade de l'ADR (§14.2, antidatage) est proposée.
      if (outcome.kind !== 'failed') {
        setNotice({ text: outcome.kind === 'cancelled' ? t('sync.forget.cancelled') : t('sync.forget.done', { device: name }), storedAt: null });
        return;
      }
      // L'état relu par le service (avant le retour de `forgetDevice`) dit si l'échec a été gardé.
      const stored = sync.status().forget?.failure ?? null;
      const storedAt = stored?.deviceId === device.deviceId && stored.step === 'declare' ? stored.at : null;
      setNotice({ text: forgetFailureText({ deviceId: device.deviceId, code: outcome.code, step: 'declare' }, status.devices), storedAt });
    } finally {
      setBusy(false);
    }
  };

  // Y-10 (§18 point 12) : oubli annulé (l'appareil qui l'avait oublié a lui-même été oublié) : dit sur la ligne, « Oublier » proposé.
  const revived = status.forget?.revived?.includes(device.deviceId) === true;

  return (
    <>
      {revived && (
        <span role="status" className="ct-sync__deviceRead ct-sync__forgetLine" data-revived="true">
          {t('sync.forget.revivedLine')}
        </span>
      )}
      <Button variant="secondary" ariaLabel={t('sync.forget.actionLabel', { device: name })} onClick={() => setOpen(true)} disabled={busy} ariaBusy={busy} className="ct-settings__link">
        {t('sync.forget.action')}
      </Button>
      {notice && (notice.storedAt === null || status.forget?.failure?.at === notice.storedAt) && (
        <span role="status" className="ct-sync__deviceRead">
          {notice.text}
        </span>
      )}
      {open && <ForgetDeviceDialog deviceName={name} onContinue={() => void forget()} onCancel={() => setOpen(false)} />}
    </>
  );
}
