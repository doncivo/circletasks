import { parseAppLockSetting, shouldLock } from '../../domain/appLock';
import { t } from '../../i18n';
import type { AppAuthenticator, AuthFailureCode, AuthResult } from '../../platform/biometric';
import { logFailure } from '../../platform/desktop/log';
import type { PrivacyShield } from '../../platform/privacyShield';
import type { AppContainer } from '../app/container';
import { useAppLockStore, type AppLockActions, type LockMessage, type SettingsLockMessage } from './appLockStore';
import { takeExcursion } from './excursion';
import { applyLockToDocument, stopLockObserver } from './lockLayer';
import { installPrivacyCover, setPrivacyCover } from './privacyCover';

export { applyLockToDocument, ensureLockLayer, LOCK_LAYER_ID, stopLockObserver } from './lockLayer';

/**
 * Exécution du verrouillage (I-03, ADR 0013 §2.4). Le verrou couvre l'interface, jamais les données : la base, la synchro, la
 * replanification des rappels et les autres intégrations démarrent et continuent normalement.
 *
 * - Démarrage : réglage lu avant le premier rendu de la coquille (App.tsx, avec l'apparence) ; illisible ou erreur → verrouillé.
 * - Verrou : écriture DOM directe (racine `hidden`, `inert`, `aria-hidden` ; `html[data-app-lock]`) dans le même traitement que la
 *   décision, puis l'écran de verrou (`AppLockGate`) ; la coquille déjà montée le reste (état et saisie conservés).
 * - Aucun chemin `locked` → `unlocked` sans `AuthResult.ok`, sauf la sortie « aucun code » confirmée (critère 9).
 */

export interface AppLockDeps {
  readonly authenticator: AppAuthenticator;
  readonly shield: PrivacyShield;
  readonly readSetting: () => Promise<unknown>;
  readonly writeSetting: (enabled: boolean) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (code: string) => void;
  readonly doc?: Document;
  readonly win?: Window;
}

export interface AppLockController extends AppLockActions {
  /** Réglage lu, état posé, écouteurs installés. */
  readonly ready: Promise<void>;
  dispose(): void;
}


const PLUGIN_FAILURES: ReadonlySet<AuthFailureCode> = new Set(['unavailable', 'unknown', 'invalid-context']);

function messageOf(result: Extract<AuthResult, { ok: false }>): LockMessage {
  if (result.cancelled) return { kind: 'cancelled' };
  if (result.code === 'passcode-not-set') return { kind: 'no-passcode' };
  if (PLUGIN_FAILURES.has(result.code)) return { kind: 'plugin', code: result.code };
  return { kind: 'failed', code: result.code };
}

function refusal(main: SettingsLockMessage['main'], result: Extract<AuthResult, { ok: false }>): SettingsLockMessage {
  if (result.code === 'passcode-not-set') return { main, detail: 'noPasscode', code: null };
  if (PLUGIN_FAILURES.has(result.code)) return { main, detail: 'unsupported', code: result.code };
  return { main, detail: null, code: null };
}

export function startAppLock(deps: AppLockDeps): AppLockController {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((code: string) => logFailure('security', code));
  const store = useAppLockStore;
  const set = (patch: Partial<ReturnType<typeof store.getState>>): void => store.setState(patch);

  let disposed = false;
  let removeCover: (() => void) | null = null;
  let backgroundedAt: number | null = null;
  /** Épisode de verrou en cours (lancement ou retour) : une authentification automatique, un seul nouvel essai au `focus`. */
  let episode: { autoTried: boolean; retryOnFocus: boolean; focusRetried: boolean } | null = null;

  const lock = (message: LockMessage | null): void => {
    episode = { autoTried: false, retryOnFocus: false, focusRetried: false };
    applyLockToDocument(doc, true);
    set({ phase: 'locked', message, busy: false });
  };

  const unlocked = (): void => {
    episode = null;
    applyLockToDocument(doc, false);
    set({ phase: 'unlocked', shellReady: true, message: null, busy: false });
  };

  const applyShield = async (enabled: boolean): Promise<void> => {
    const result = await deps.shield.setEnabled(enabled);
    if (disposed) return;
    if (result.ok) {
      set({ shieldFailure: null });
    } else {
      log(`privacy-shield-failed:${result.code}`);
      set({ shieldFailure: enabled ? result.code : null });
    }
  };

  const unlock = async (): Promise<void> => {
    if (store.getState().phase !== 'locked' || store.getState().busy) return;
    set({ busy: true });
    const result = await deps.authenticator.authenticate(t('security.reason.unlock'), t('security.cancel'));
    if (disposed || store.getState().phase !== 'locked') return;
    if (result.ok) {
      unlocked();
      return;
    }
    if (result.code === 'passcode-not-set') set({ noPasscodeExit: true });
    if ((result.code === 'not-interactive' || result.code === 'system-cancel') && episode && !episode.focusRetried) episode.retryOnFocus = true;
    set({ busy: false, message: messageOf(result) });
  };

  const requestAutoUnlock = (): void => {
    if (store.getState().phase !== 'locked' || !episode || episode.autoTried || doc.visibilityState === 'hidden') return;
    episode.autoTried = true;
    void unlock();
  };

  const onFocus = (): void => {
    if (store.getState().phase !== 'locked' || !episode?.retryOnFocus) return;
    episode.retryOnFocus = false;
    episode.focusRetried = true;
    void unlock();
  };

  const onHidden = (): void => {
    backgroundedAt ??= now();
  };

  const onVisible = (): void => {
    const at = backgroundedAt;
    backgroundedAt = null;
    const state = store.getState();
    if (!state.enabled) {
      setPrivacyCover(doc, false);
      return;
    }
    if (state.phase === 'locked') {
      setPrivacyCover(doc, false);
      requestAutoUnlock();
      return;
    }
    // Audit M1 : seule l'excursion vers Réglages iOS dispense du délai ; dossier, caméra et autorisation suivent la règle des 30 s.
    const taken = takeExcursion();
    const excursion = taken?.kind === 'system-settings' ? { startedAt: taken.startedAt } : null;
    const relock = shouldLock({ enabled: true, state: 'resume', now: now(), backgroundedAt: at, excursion });
    // Verrou posé AVANT le retrait du cache : le contenu n'est jamais repeint entre les deux.
    if (relock) lock(null);
    setPrivacyCover(doc, false);
    if (relock) requestAutoUnlock();
  };

  const enable = async (): Promise<void> => {
    const state = store.getState();
    if (state.busy || state.enabled) return;
    if (!deps.authenticator.supported) {
      set({ settingsMessage: { main: 'notEnabled', detail: 'unsupported', code: 'unavailable' } });
      return;
    }
    set({ busy: true, settingsMessage: null });
    const status = await deps.authenticator.status();
    if (status.passcode === 'not-set') {
      set({ busy: false, settingsMessage: { main: 'notEnabled', detail: 'noPasscode', code: null } });
      return;
    }
    const result = await deps.authenticator.authenticate(t('security.reason.enable'), t('security.cancel'));
    if (disposed) return;
    if (!result.ok) {
      set({ busy: false, settingsMessage: refusal('notEnabled', result) });
      return;
    }
    try {
      await deps.writeSetting(true);
    } catch {
      log('setting-write-failed');
      set({ busy: false, settingsMessage: { main: 'notEnabled', detail: 'saveFailed', code: null } });
      return;
    }
    set({ busy: false, enabled: true, settingsMessage: null });
    await applyShield(true);
  };

  const disable = async (): Promise<void> => {
    const state = store.getState();
    if (state.busy || !state.enabled) return;
    set({ busy: true, settingsMessage: null });
    const result = await deps.authenticator.authenticate(t('security.reason.disable'), t('security.cancel'));
    if (disposed) return;
    if (!result.ok) {
      set({ busy: false, settingsMessage: refusal('notDisabled', result) });
      return;
    }
    try {
      await deps.writeSetting(false);
    } catch {
      log('setting-write-failed');
      set({ busy: false, settingsMessage: { main: 'notDisabled', detail: 'saveFailed', code: null } });
      return;
    }
    set({ busy: false, enabled: false, settingsMessage: null });
    setPrivacyCover(doc, false);
    await applyShield(false);
  };

  const disableWithoutPasscode = async (): Promise<void> => {
    const state = store.getState();
    if (state.phase !== 'locked' || !state.noPasscodeExit || state.busy) return;
    set({ busy: true });
    try {
      await deps.writeSetting(false);
    } catch {
      log('setting-write-failed');
      set({ busy: false, message: { kind: 'disable-failed' } });
      return;
    }
    if (disposed) return;
    log('app-lock-disabled-no-passcode');
    set({ enabled: false, noPasscodeExit: false });
    unlocked();
    await applyShield(false);
  };

  const ready = (async (): Promise<void> => {
    if (!deps.authenticator.supported) {
      // PC et navigateur : aucune authentification possible, aucun verrou (l'option n'y existe pas).
      set({ phase: 'unlocked', enabled: false, shellReady: true });
      return;
    }
    let enabled = true;
    let unreadable = true;
    try {
      ({ enabled, unreadable } = parseAppLockSetting(await deps.readSetting()));
    } catch {
      // Lecture impossible : échec fermé.
    }
    if (disposed) return;
    if (unreadable) log('setting-unreadable');
    set({ enabled });
    if (shouldLock({ enabled, state: 'cold-start', now: now(), backgroundedAt: null, excursion: null })) lock(unreadable ? { kind: 'setting-unreadable' } : null);
    else unlocked();
    removeCover = installPrivacyCover({ doc, win, isEnabled: () => store.getState().enabled, onHidden, onVisible });
    win.addEventListener('focus', onFocus);
    void applyShield(enabled);
  })();

  const actions: AppLockActions = { unlock, enable, disable, disableWithoutPasscode, requestAutoUnlock };
  set({ actions });

  return {
    ...actions,
    ready,
    dispose: () => {
      disposed = true;
      stopLockObserver(doc);
      removeCover?.();
      win.removeEventListener('focus', onFocus);
      if (store.getState().actions === actions) set({ actions: null });
    },
  };
}

/** Branchement sur le conteneur : réglage local `security.appLock`, plugins de l'iPhone, journal technique. */
export function startAppLockFor(container: AppContainer): AppLockController {
  const settings = container.data.repos.settings;
  return startAppLock({
    authenticator: container.authenticator,
    shield: container.privacyShield,
    readSetting: () => settings.get('security.appLock'),
    writeSetting: (enabled) => settings.set('security.appLock', enabled),
    now: () => container.clock.nowMs(),
  });
}
