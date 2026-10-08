import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t, type PlainMessageKey } from '../../i18n';
import { syncErrorCodeOf, type CameraPermission, type SyncErrorCode, type SyncPlatform } from '../../platform/sync/types';
import { X } from 'lucide-react';
import { Button, Icon } from '../../ui';
import { useFocusTrap } from '../../ui/useFocusTrap';
import { useAppContainer } from '../app/AppContainerContext';
import { JoinProgress } from './JoinProgress';
import { handleSyncPaired } from './pairingStatus';
import { RecoveryKeyEntry } from './pairing-window/RecoveryKeyEntry';
import { pairingTexts } from './pairing-window/pairingText';
import './IosPairingScreen.css';
import { openCameraSettings, withExcursion } from '../security/excursion';

/** Classe posée sur `<html>` pendant le scan : la WebView devient transparente, la caméra du plugin est derrière (ADR 0011 §23 point 7). */
export const SCANNING_CLASS = 'ct-scanning';

/** Texte d'un échec d'association sur l'iPhone (jamais le message technique, jamais le texte du QR). */
export function iosPairingErrorKey(code: SyncErrorCode): PlainMessageKey {
  switch (code) {
    case 'invalid-pairing':
      return 'sync.pairing.ios.errors.invalidPairing';
    case 'key-mismatch':
      return 'sync.pairing.ios.errors.keyMismatch';
    case 'cloud-pending':
      return 'sync.pairing.ios.errors.cloudPending';
    case 'pairing-expired':
      return 'sync.pairing.ios.errors.pairingExpired';
    case 'consent-denied':
      return 'sync.pairing.ios.errors.consentDenied';
    case 'not-foreground':
      return 'sync.pairing.ios.errors.notForeground';
    case 'rate-limited':
      return 'sync.pairing.ios.errors.rateLimited';
    case 'not-configured':
      return 'sync.pairing.ios.errors.notConfigured';
    default:
      return 'sync.pairing.ios.errors.generic';
  }
}

type Stage = 'loading' | 'folder' | 'camera' | 'scanning' | 'receiving' | 'recovery' | 'done';

export interface IosPairingScreenProps {
  readonly platform: SyncPlatform;
  readonly onClose: () => void;
  /** Document observé (retour au premier plan : autorisation de la caméra relue) ; tests : injecté. */
  readonly document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener' | 'documentElement' | 'body'>;
}

/**
 * Écran « Associer au PC » de l'iPhone (ADR 0011 §23 point 7, d'après Appairage.html ; Y-IOS-02 critères 7 et 14) : **dossier d'abord, clé
 * ensuite** (section 10.3) : choix du dossier s'il n'est pas lié, explication de la caméra puis demande d'iOS au premier usage, scan (écran
 * de visée avec « Annuler », WebView transparente), réception de la clé, progression de l'arrivée. « Saisir la clé de secours à la place » :
 * saisie existante (`RecoveryKeyEntry`), dans la fenêtre principale (une seule WebView sur l'iPhone, section 2.1).
 *
 * Aucun texte du QR ni aucune clé ne passe par cet écran : le scan et l'import se font dans `tauriSync.ts` (`scanAndImport`), qui ne rend
 * que l'issue. Caméra refusée : état lu du système à l'affichage et à chaque retour au premier plan, « Ouvrir les réglages ». Un échec (refus
 * de la confirmation native, trop de tentatives…) reste affiché jusqu'à la tentative réussie suivante. L'iPhone n'affiche jamais le QR.
 */
export function IosPairingScreen({ platform, onClose, document: injected }: IosPairingScreenProps) {
  const container = useAppContainer();
  const doc = injected ?? globalThis.document;
  const [stage, setStage] = useState<Stage>('loading');
  const [folderReady, setFolderReady] = useState(false);
  const [camera, setCamera] = useState<CameraPermission>('prompt');
  const [message, setMessage] = useState<PlainMessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const ref = useFocusTrap<HTMLDivElement>({ active: stage !== 'scanning', onEscape: onClose });

  const readCamera = useCallback(async (): Promise<void> => {
    const state = (await platform.key.cameraPermission?.()) ?? 'prompt';
    if (mounted.current) setCamera(state);
  }, [platform]);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      let configured = false;
      try {
        configured = (await platform.folder.info()).configured;
      } catch (error) {
        // Dossier lié mais injoignable : à choisir de nouveau (§22 point 8), le message le dit.
        if (mounted.current) setMessage(syncErrorCodeOf(error) === 'folder-unreachable' ? 'sync.status.errorFolderUnreachableIos' : 'sync.pairing.ios.errors.generic');
      }
      await readCamera();
      if (!mounted.current) return;
      setFolderReady(configured);
      setStage(configured ? 'camera' : 'folder');
    })();
    return () => {
      mounted.current = false;
    };
  }, [platform, readCamera]);

  // Retour au premier plan (réglages d'iOS) : autorisation relue.
  useEffect(() => {
    if (!doc) return;
    const onVisibility = (): void => {
      if (doc.visibilityState !== 'hidden') void readCamera();
    };
    doc.addEventListener('visibilitychange', onVisibility);
    return () => doc.removeEventListener('visibilitychange', onVisibility);
  }, [doc, readCamera]);

  // WebView transparente pendant le scan (caméra du plugin derrière) ; retirée à la fin du scan et au démontage.
  useEffect(() => {
    const root = doc?.documentElement;
    if (!root || stage !== 'scanning') return;
    root.classList.add(SCANNING_CLASS);
    return () => root.classList.remove(SCANNING_CLASS);
  }, [doc, stage]);

  const chooseFolder = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const info = await withExcursion('folder-picker', () => platform.folder.choose());
      if (!info) return;
      await platform.bindDevice(container.hlc.deviceId);
      setFolderReady(true);
      setStage('camera');
    } catch (error) {
      setMessage(iosPairingErrorKey(syncErrorCodeOf(error)));
    } finally {
      setBusy(false);
    }
  };

  const paired = async (): Promise<void> => {
    setMessage(null);
    setStage('done');
    // Même suite que l'arrivée sur PC : échec gardé effacé, cycle lancé (progression de l'arrivée), écrans prévenus.
    await handleSyncPaired(container);
  };

  const scan = async (): Promise<void> => {
    if (!platform.key.scanAndImport) return;
    setMessage(null);
    setStage('scanning');
    const scanAndImport = platform.key.scanAndImport.bind(platform.key);
    // I-03 : caméra (et sa demande d'autorisation) = excursion, pas de reverrouillage immédiat au retour.
    const outcome = await withExcursion('camera', scanAndImport);
    if (!mounted.current) return;
    switch (outcome.kind) {
      case 'imported':
        setCamera('granted');
        setStage('receiving');
        await paired();
        return;
      case 'cancelled':
        setStage('camera');
        setMessage('sync.pairing.ios.scanCancelled');
        return;
      case 'camera-denied':
        setCamera('denied');
        setStage('camera');
        return;
      case 'failed':
        setStage('camera');
        setMessage(iosPairingErrorKey(outcome.code));
        void readCamera();
    }
  };

  const cancelScan = (): void => {
    void platform.key.cancelScan?.();
  };

  const steps: { readonly key: PlainMessageKey; readonly done: boolean; readonly current: boolean }[] = [
    { key: 'sync.pairing.ios.stepFolder', done: folderReady, current: stage === 'folder' },
    { key: 'sync.pairing.ios.stepCamera', done: camera === 'granted', current: stage === 'camera' },
    { key: 'sync.pairing.ios.stepKey', done: stage === 'done', current: stage === 'scanning' || stage === 'receiving' || stage === 'recovery' },
  ];

  if (stage === 'scanning') {
    // Écran de visée : la caméra est derrière la WebView rendue transparente ; seul ce cadre et « Annuler » restent visibles.
    return createPortal(
      <div className="ct-ios-pair ct-ios-pair--scan" role="dialog" aria-modal="true" aria-label={t('sync.pairing.ios.title')}>
        <p className="ct-ios-pair__aim">{t('sync.pairing.ios.aim')}</p>
        <div className="ct-ios-pair__frame" aria-hidden="true">
          <span className="ct-ios-pair__corner ct-ios-pair__corner--tl" />
          <span className="ct-ios-pair__corner ct-ios-pair__corner--tr" />
          <span className="ct-ios-pair__corner ct-ios-pair__corner--bl" />
          <span className="ct-ios-pair__corner ct-ios-pair__corner--br" />
        </div>
        <button type="button" className="ct-ios-pair__outline" aria-label={t('sync.pairing.ios.cancelScanLabel')} onClick={cancelScan}>
          {t('sync.pairing.ios.cancel')}
        </button>
      </div>,
      doc?.body ?? globalThis.document.body,
    );
  }

  return createPortal(
    <div ref={ref} className="ct-ios-pair" role="dialog" aria-modal="true" aria-labelledby="ct-ios-pair-title" tabIndex={-1}>
      <div className="ct-ios-pair__bar">
        <button type="button" className="ct-ios-pair__close" aria-label={t('sync.pairing.ios.cancelLabel')} onClick={onClose}>
          <Icon icon={X} size={24} />
        </button>
        <span className="ct-ios-pair__section">{t('sync.pairing.ios.section')}</span>
        <span className="ct-ios-pair__spacer" />
      </div>
      {stage === 'recovery' ? (
        <div className="ct-ios-pair__recovery">
          <RecoveryKeyEntry
            platform={{
              pairingPayload: () => Promise.reject(new Error('iPhone')),
              closePairing: async () => {
                if (mounted.current) setStage(folderReady ? 'camera' : 'folder');
              },
              import: async (input) => {
                const result = await platform.key.import({ recoveryKey: input.recoveryKey });
                void paired();
                return result;
              },
            }}
            texts={pairingTexts()}
            closeAfterMs={5 * 60_000}
          />
        </div>
      ) : (
        <>
          <h1 id="ct-ios-pair-title" className="ct-ios-pair__title">
            {t('sync.pairing.ios.title')}
          </h1>
          <p className="ct-ios-pair__hint">{t('sync.pairing.ios.hint')}</p>
          <ol className="ct-ios-pair__steps">
            {steps.map((step) => (
              <li key={step.key} className="ct-ios-pair__step" data-done={step.done} data-current={step.current}>
                <span className="ct-ios-pair__dot" aria-hidden="true">
                  {step.done ? '✓' : ''}
                </span>
                {t(step.key)}
              </li>
            ))}
          </ol>
          <div className="ct-ios-pair__body" aria-live="polite">
            {stage === 'folder' && (
              <>
                <p className="ct-ios-pair__text">{t('sync.pairing.ios.folderFirst')}</p>
                <Button ariaLabel={t('sync.pairing.ios.chooseFolderLabel')} onClick={() => void chooseFolder()} disabled={busy}>
                  {t('sync.pairing.ios.chooseFolder')}
                </Button>
              </>
            )}
            {stage === 'camera' && camera !== 'denied' && (
              <>
                <p className="ct-ios-pair__text">{t('sync.pairing.ios.cameraExplain')}</p>
                <Button ariaLabel={t('sync.pairing.ios.scanLabel')} onClick={() => void scan()} disabled={!platform.key.scanAndImport}>
                  {t('sync.pairing.ios.scan')}
                </Button>
              </>
            )}
            {stage === 'camera' && camera === 'denied' && (
              <>
                <p className="ct-ios-pair__text ct-ios-pair__text--danger" role="status" data-testid="ios-camera-denied">
                  {t('sync.pairing.ios.cameraDenied')}
                </p>
                <p className="ct-ios-pair__text">{t('sync.pairing.ios.cameraDeniedHint')}</p>
                <Button ariaLabel={t('sync.pairing.ios.openSettingsLabel')} onClick={() => void openCameraSettings(platform)}>
                  {t('sync.pairing.ios.openSettings')}
                </Button>
              </>
            )}
            {stage === 'receiving' && <p className="ct-ios-pair__text">{t('sync.pairing.ios.receiving')}</p>}
            {stage === 'done' && (
              <>
                <p className="ct-ios-pair__text ct-ios-pair__text--ok" role="status">
                  {t('sync.pairing.ios.done')}
                </p>
                <div className="ct-ios-pair__progress">
                  <JoinProgress />
                </div>
              </>
            )}
            {message && (
              <p className="ct-ios-pair__text ct-ios-pair__text--danger" role="status" data-testid="ios-pairing-message">
                {t(message)}
              </p>
            )}
          </div>
          <div className="ct-ios-pair__grow" />
          {stage !== 'done' && stage !== 'loading' && (
            <div className="ct-ios-pair__footer">
              {folderReady && (
                <button type="button" className="ct-ios-pair__outline" aria-label={t('sync.pairing.ios.recoveryLabel')} onClick={() => setStage('recovery')}>
                  {t('sync.pairing.ios.recovery')}
                </button>
              )}
            </div>
          )}
          {stage === 'done' && (
            <div className="ct-ios-pair__footer">
              <button type="button" className="ct-ios-pair__outline" onClick={onClose}>
                {t('sync.pairing.ios.close')}
              </button>
            </div>
          )}
        </>
      )}
    </div>,
    doc?.body ?? globalThis.document.body,
  );
}
