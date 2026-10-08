import { useEffect, useState } from 'react';
import { t, type PlainMessageKey } from '../../i18n';
import { openSyncPlatform, syncErrorCodeOf, type SyncErrorCode, type SyncFolderInfo, type SyncPlatform } from '../../platform/sync';
import { Button, ChoiceDialog } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import type { AppContainer } from '../app/container';
import { JoinProgress } from './JoinProgress';
import { onPairingChange, openPairingWindow, pairingOpenErrorKey, readPairingFailure, type PairingFailure } from './pairingStatus';
import { SyncStatusLine } from './SyncStatusLine';
import { syncStore } from './syncStore';
import { failureLine, folderLabel } from './syncText';
import { IosPairingRow } from './IosPairingRow';
import { IosPairingScreen } from './IosPairingScreen';

export { folderLabel };
import './SyncSettingsSection.css';
import { withExcursion } from '../security/excursion';

/** Une plateforme par conteneur : le dossier choisi en mémoire (navigateur de développement) survit à la navigation. */
const platforms = new WeakMap<AppContainer, SyncPlatform>();

function platformOf(container: AppContainer): SyncPlatform {
  let platform = platforms.get(container);
  if (!platform) {
    platform = openSyncPlatform(container.platform.runtime, container.platform.os);
    platforms.set(container, platform);
  }
  return platform;
}

type View =
  | { readonly kind: 'loading' }
  | { readonly kind: 'not-configured' }
  | { readonly kind: 'bound'; readonly info: SyncFolderInfo; readonly needsPairing: boolean }
  /** `configured` : un dossier est lié (erreur du dossier lié) ; faux si c'est le choix d'un dossier qui a échoué (revue 6). */
  | { readonly kind: 'error'; readonly code: SyncErrorCode; readonly info: SyncFolderInfo | null; readonly configured: boolean };

type ForgetChoice = 'folder' | 'folder-and-key';

/** Texte affiché pour un code d'erreur (jamais le message technique de Rust) ; `ios` : textes de l'iPhone (ADR 0011 §22 point 8). */
export function syncErrorMessageKey(code: SyncErrorCode, ios = false): PlainMessageKey {
  switch (code) {
    case 'unsafe-folder':
    case 'not-local':
      return 'sync.folder.errorUnsafe';
    case 'folder-unreachable':
      return ios ? 'sync.folder.errorUnreachableIos' : 'sync.folder.errorUnreachable';
    case 'folder-too-large':
      return 'sync.folder.errorTooLarge';
    case 'cloud-provider-stopped':
      return 'sync.folder.errorProviderStopped';
    case 'vault-unavailable':
      return ios ? 'sync.folder.errorVaultIos' : 'sync.folder.errorVault';
    case 'consent-denied':
      return 'sync.folder.errorDenied';
    case 'rate-limited':
      return 'sync.folder.errorRateLimited';
    case 'not-foreground':
      return 'sync.pairing.openBackground';
    case 'key-mismatch':
      return 'sync.key.mismatch';
    case 'folder-has-data':
      return 'sync.key.needsPairing';
    default:
      return 'sync.folder.errorGeneric';
  }
}

/** État de la section, lu sur la plateforme : dossier, puis présence de la clé. */
async function readView(platform: SyncPlatform): Promise<View> {
  let info: SyncFolderInfo;
  try {
    info = await platform.folder.info();
  } catch (error) {
    // `info()` n'échoue que pour un dossier lié devenu inutilisable (introuvable, jonction).
    return { kind: 'error', code: syncErrorCodeOf(error), info: null, configured: true };
  }
  if (!info.configured) return { kind: 'not-configured' };
  try {
    const key = await platform.key.status();
    return { kind: 'bound', info, needsPairing: !key.present };
  } catch (error) {
    return { kind: 'error', code: syncErrorCodeOf(error), info, configured: true };
  }
}

/**
 * Section « SYNCHRONISATION » de Réglages (Reglages.html ; Y-01 critères 1, 2, 5, 10, 17 à 19 ; Y-08). Sans dossier : « Non
 * configurée » et « Choisir le dossier » (boîte système ouverte par Rust). Dossier lié : son libellé (jamais un chemin) et, en
 * sous-ligne, « Dossier choisi » (l'état « À jour · il y a 2 min » et le lien « Détails » arrivent avec Y-02), l'avertissement d'un
 * dossier hors iCloud, ou « associez cet appareil » si le dossier contient déjà des données chiffrées. « Oublier » propose d'oublier le
 * dossier seul (la clé est gardée) ou le dossier et la clé (confirmation native de Rust). Aucun bouton « Associer » avant Y-06.
 * Absente quand la plateforme ne synchronise pas (iPhone jusqu'à l'ordre 5). Aucune clé ni aucun chemin ne passe par cet écran.
 */
export function SyncSettingsSection({ platform: injected }: { readonly platform?: SyncPlatform }) {
  const container = useAppContainer();
  // Même plateforme que le service de synchro (conteneur), pour que le cycle voie le dossier et la clé choisis ici.
  const platform = injected ?? container.syncPlatform ?? platformOf(container);
  const available = platform.available();
  const ios = container.platform.os === 'ios';
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);
  // Y-07 (exigence d'Ali, revue 2) : un échec de réintégration reste visible même sans dossier de synchro.
  const failure = useFeatureStore(syncStore, (s) => s.status.reintegrationFailure ?? null);
  // Y-06 (branche needsPairing) : « Associer cet appareil », échec d'ouverture gardé jusqu'à la réussite, retour à l'état normal à l'association.
  const [pairingFailure, setPairingFailure] = useState<PairingFailure | null>(null);
  const [pairingNotice, setPairingNotice] = useState<PlainMessageKey | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  // iPhone (§23 point 7) : écran « Associer au PC » ouvert ; il reste ouvert quand l'association change la ligne.
  const [iosPairing, setIosPairing] = useState(false);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    const refreshFailure = (): void => {
      void readPairingFailure(container).then((value) => {
        if (!cancelled) setPairingFailure(value);
      });
    };
    refreshFailure();
    const stop = onPairingChange(container, (event) => {
      refreshFailure();
      if (event !== 'paired') return;
      setPairingNotice(null);
      void readView(platform).then((next) => {
        if (!cancelled) setView(next);
      });
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [available, container, platform]);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    void readView(platform).then((next) => {
      if (!cancelled) setView(next);
    });
    return () => {
      cancelled = true;
    };
  }, [available, platform]);

  if (!available) return null;

  /** Choix du dossier, puis clé (créée seulement si le dossier n'a pas de données chiffrées) et liaison de l'appareil (critère 10). */
  const choose = async () => {
    setBusy(true);
    let info: SyncFolderInfo | null = null;
    const wasConfigured = view.kind === 'bound' || (view.kind === 'error' && view.configured);
    try {
      info = await withExcursion('folder-picker', () => platform.folder.choose());
      if (!info) return;
      let needsPairing = false;
      const key = await platform.key.status();
      if (!key.present) {
        try {
          await platform.key.create();
        } catch (error) {
          if (syncErrorCodeOf(error) !== 'folder-has-data') throw error;
          needsPairing = true;
        }
      }
      await platform.bindDevice(container.hlc.deviceId);
      setView({ kind: 'bound', info, needsPairing });
      // Premier cycle tout de suite (docs/decisions.md, Y-02) : le premier fichier ne doit pas attendre 5 minutes.
      if (!needsPairing) void container.sync?.syncNow('open');
    } catch (error) {
      // Dossier refusé par le contrôle : rien n'a été lié, « Choisir le dossier » reste proposé ; un dossier lié puis un échec de
      // clé ou de liaison : « Oublier » (revue 6).
      setView({ kind: 'error', code: syncErrorCodeOf(error), info, configured: wasConfigured || info !== null });
    } finally {
      setBusy(false);
    }
  };

  const forget = async (choice: ForgetChoice) => {
    setForgetOpen(false);
    setBusy(true);
    try {
      await platform.folder.forget({ eraseKey: choice === 'folder-and-key' });
      setView(await readView(platform));
    } catch (error) {
      const info = view.kind === 'bound' || view.kind === 'error' ? view.info : null;
      setView({ kind: 'error', code: syncErrorCodeOf(error), info, configured: true });
    } finally {
      setBusy(false);
    }
  };

  const associate = async (): Promise<void> => {
    setPairingBusy(true);
    setPairingNotice(null);
    try {
      const code = await openPairingWindow(container, 'import', platform);
      if (code) setPairingNotice(pairingOpenErrorKey(code, 'import'));
    } finally {
      setPairingBusy(false);
    }
  };
  const pairingMessage = pairingNotice ?? (pairingFailure && pairingFailure.mode === 'import' ? pairingOpenErrorKey(pairingFailure.code, 'import') : null);

  const chooseButton = (
    <Button variant="secondary" ariaLabel={t('sync.folder.chooseLabel')} onClick={() => void choose()} className="ct-settings__link" disabled={busy}>
      {busy ? t('sync.folder.choosing') : t('sync.folder.choose')}
    </Button>
  );
  const forgetButton = (
    <Button variant="secondary" ariaLabel={t('sync.folder.forgetLabel')} onClick={() => setForgetOpen(true)} className="ct-settings__link" disabled={busy}>
      {t('sync.folder.forget')}
    </Button>
  );

  return (
    <>
      <h2 className="ct-settings__section">{t('sync.folder.sectionTitle')}</h2>
      {view.kind === 'loading' && (
        <div className="ct-settings__row" aria-busy="true">
          <span>{t('sync.folder.rowLabel')}</span>
        </div>
      )}
      {view.kind === 'not-configured' && (
        <div className="ct-settings__row">
          <span className="ct-settings__stack">
            {t('sync.folder.rowLabel')}
            <span className="ct-settings__hint" data-testid="sync-folder-state">
              {t('sync.folder.notConfigured')}
            </span>
            {failure && (
              <span className="ct-settings__hint ct-settings__hint--danger" role="status" data-testid="sync-reintegration-failure">
                {failureLine(failure.fields)}
              </span>
            )}
          </span>
          {chooseButton}
        </div>
      )}
      {view.kind === 'bound' && (
        <div className="ct-settings__row">
          <span className="ct-settings__stack">
            {container.sync && !view.needsPairing ? <SyncStatusLine /> : folderLabel(view.info)}
            {container.sync && !view.needsPairing ? null : view.needsPairing ? (
              <span className="ct-settings__hint ct-settings__hint--danger" role="status" data-testid="sync-folder-state">
                {t('sync.key.needsPairing')}
              </span>
            ) : (
              <span className="ct-settings__hint ct-sync__ok" data-testid="sync-folder-state">
                {t('sync.folder.chosen')}
              </span>
            )}
            {view.info.kind !== 'icloud' && (
              <span className="ct-settings__hint ct-settings__hint--danger" role="status" data-testid="sync-folder-warning">
                {t('sync.folder.notIcloud')}
              </span>
            )}
          </span>
          {forgetButton}
        </div>
      )}
      {/* iPhone (ADR 0011 §23 point 7) : « Associer au PC » (dossier d'abord, clé ensuite), jamais la fenêtre `pairing` du PC. */}
      {ios && (view.kind === 'not-configured' || (view.kind === 'bound' && view.needsPairing)) && <IosPairingRow platform={platform} onOpen={() => setIosPairing(true)} />}
      {iosPairing && (
        <IosPairingScreen
          platform={platform}
          onClose={() => {
            setIosPairing(false);
            void readView(platform).then(setView);
          }}
        />
      )}
      {view.kind === 'bound' && view.needsPairing && !ios && (
        <div className="ct-settings__row">
          <span className="ct-settings__stack">
            {t('sync.pairing.importLabel')}
            {pairingMessage && (
              <span className="ct-settings__hint ct-settings__hint--danger" role="status" data-testid="sync-pairing-notice">
                {t(pairingMessage)}
              </span>
            )}
          </span>
          <Button variant="secondary" ariaLabel={t('sync.pairing.importLabel')} onClick={() => void associate()} className="ct-settings__link" disabled={pairingBusy || busy}>
            {pairingBusy ? t('sync.pairing.opening') : t('sync.pairing.importAction')}
          </Button>
        </div>
      )}
      {view.kind === 'bound' && !view.needsPairing && <JoinProgress />}
      {view.kind === 'error' && (
        <div className="ct-settings__row">
          <span className="ct-settings__stack">
            {folderLabel(view.info)}
            <span className="ct-settings__hint ct-settings__hint--danger" role="status" data-testid="sync-folder-state">
              {t(syncErrorMessageKey(view.code, ios))}
            </span>
          </span>
          {/* iPhone (§22 point 8) : signet perdu ou dossier déplacé : « Choisir le dossier » de nouveau (même dossier : rien n'est perdu). */}
          {view.configured && ios && view.code === 'folder-unreachable' && chooseButton}
          {view.configured ? forgetButton : chooseButton}
        </div>
      )}
      {forgetOpen && (
        <ChoiceDialog<ForgetChoice>
          title={t('sync.folder.forgetTitle')}
          description={t('sync.folder.forgetDescription')}
          options={[
            { id: 'folder', label: t('sync.folder.forgetFolder') },
            // Effacer la clé demande une confirmation native : masqué tant qu'elle n'existe pas sur cet appareil (§22 point 7).
            { id: 'folder-and-key' as const, label: t('sync.folder.forgetFolderAndKey') },
          ]}
          optionVariant="danger"
          onChoose={(choice) => void forget(choice)}
          onCancel={() => setForgetOpen(false)}
        />
      )}
    </>
  );
}
