import { useEffect, useState } from 'react';
import { t, type PlainMessageKey } from '../../i18n';
import { openSyncPlatform, syncErrorCodeOf, type SyncErrorCode, type SyncFolderInfo, type SyncPlatform } from '../../platform/sync';
import { Button, ChoiceDialog } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import type { AppContainer } from '../app/container';
import './SyncSettingsSection.css';

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

/** Texte affiché pour un code d'erreur (jamais le message technique de Rust). */
export function syncErrorMessageKey(code: SyncErrorCode): PlainMessageKey {
  switch (code) {
    case 'unsafe-folder':
    case 'not-local':
      return 'sync.folder.errorUnsafe';
    case 'folder-unreachable':
      return 'sync.folder.errorUnreachable';
    case 'folder-too-large':
      return 'sync.folder.errorTooLarge';
    case 'cloud-provider-stopped':
      return 'sync.folder.errorProviderStopped';
    case 'vault-unavailable':
      return 'sync.folder.errorVault';
    case 'consent-denied':
      return 'sync.folder.errorDenied';
    case 'rate-limited':
      return 'sync.folder.errorRateLimited';
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

/** Libellé affiché d'un dossier (jamais un chemin) : « iCloud Drive / <nom> » pour un dossier iCloud, sinon son nom (revue 13). */
export function folderLabel(info: Pick<SyncFolderInfo, 'label' | 'kind'> | null): string {
  if (!info?.label) return t('sync.folder.rowLabel');
  return info.kind === 'icloud' ? t('sync.folder.icloudLabel', { name: info.label }) : info.label;
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
  const platform = injected ?? platformOf(container);
  const available = platform.available();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);

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
      info = await platform.folder.choose();
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
          </span>
          {chooseButton}
        </div>
      )}
      {view.kind === 'bound' && (
        <div className="ct-settings__row">
          <span className="ct-settings__stack">
            {folderLabel(view.info)}
            {view.needsPairing ? (
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
      {view.kind === 'error' && (
        <div className="ct-settings__row">
          <span className="ct-settings__stack">
            {folderLabel(view.info)}
            <span className="ct-settings__hint ct-settings__hint--danger" role="status" data-testid="sync-folder-state">
              {t(syncErrorMessageKey(view.code))}
            </span>
          </span>
          {view.configured ? forgetButton : chooseButton}
        </div>
      )}
      {forgetOpen && (
        <ChoiceDialog<ForgetChoice>
          title={t('sync.folder.forgetTitle')}
          description={t('sync.folder.forgetDescription')}
          options={[
            { id: 'folder', label: t('sync.folder.forgetFolder') },
            { id: 'folder-and-key', label: t('sync.folder.forgetFolderAndKey') },
          ]}
          optionVariant="danger"
          onChoose={(choice) => void forget(choice)}
          onCancel={() => setForgetOpen(false)}
        />
      )}
    </>
  );
}
