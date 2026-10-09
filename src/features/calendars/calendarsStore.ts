import { createStore } from 'zustand';
import type { ChangeCursor } from '../../domain/calendarProvider';
import { calendarAppStatuses, disconnectedAccount, localAccountState, nextAccountState, shouldRefresh, type CalendarAccountState, type RefreshTrigger } from '../../domain/calendarRefresh';
import { validateCalendars } from '../../domain/externalCalendars';
import type { OrphanSecret } from '../../domain/orphanSecrets';
import type { CalendarAccount, CalendarProviderKind, CalendarRef } from '../../domain/model';
import type { CalendarAccountId, IsoDateTime } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { detectTimeZone, logFailure } from '../../platform';
import type { WebAuthFailureCode } from '../../platform/calendars';
import { useAppStatusStore } from '../app/appStatus';
import { useAppStore } from '../app/appStore';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { useNavigationStore } from '../app/navigation';
import { emitEventsChanged } from '../events/eventEvents';
import { createCalendarUseCases } from './calendarUseCases';
import { accountDisplayName } from './accountName';
import type { ConnectActions } from './calendarsConnect';
import { createProviderFor } from './providerFactory';
import { refreshAccount } from './refreshUseCase';

/**
 * Comptes d'agendas externes (K-01, K-02, K-03) : liste, connexion, choix des agendas et de leur espace (ES-06), rafraîchissement,
 * suppression. L'état d'un compte (connecté, connecté sur un autre appareil, à reconnecter, erreur) est LOCAL à l'appareil et non
 * persistant : il est recalculé au chargement (jamais connecté ici : « connecté sur un autre appareil », sans alerte ; secret absent du
 * coffre de CET appareil : « à reconnecter », K-01 D1) puis suit les résultats réseau. Aucun secret n'entre
 * dans ce store : seule une référence du coffre (`tokenRef`) existe côté interface.
 */

export type ConnectFailure =
  | 'cancelled'
  | 'not-configured'
  | 'failed'
  | 'duplicate'
  | 'icloud-invalid'
  | 'icloud-unreachable'
  | 'google-unreachable'
  | 'icloud-choose-account'
  | 'web-auth-failed'
  /** « Connecter ici » d'un compte Google reçu : l'utilisateur s'est connecté avec un autre compte Google que celui de la ligne. */
  | 'google-other-account';
export type ConnectOutcome = { readonly ok: true; readonly accountId: CalendarAccountId } | { readonly ok: false; readonly failure: ConnectFailure };

/** Message (clé i18n) d'un échec de connexion. */
export const FAILURE_KEYS: Readonly<Record<ConnectFailure, PlainMessageKey>> = {
  cancelled: 'calendars.errorCancelled',
  'not-configured': 'calendars.errorNotConfigured',
  failed: 'calendars.errorFailed',
  duplicate: 'calendars.errorDuplicate',
  'icloud-invalid': 'calendars.errorIcloudInvalid',
  'icloud-unreachable': 'calendars.errorIcloudUnreachable',
  'google-unreachable': 'calendars.errorGoogleUnreachable',
  'icloud-choose-account': 'calendars.errorIcloudChooseAccount',
  'web-auth-failed': 'calendars.errorWebAuth',
  'google-other-account': 'calendars.errorGoogleOtherAccount',
};

/**
 * Échec persistant de la session d'authentification web de l'iPhone (K-TECH-01 critère 6) : affiché avec son code et « Réessayer »
 * jusqu'à la connexion réussie ou l'annulation volontaire ; `accountId` : compte à reconnecter (null : nouveau compte Google).
 */
export interface GoogleWebAuthFailure {
  readonly code: WebAuthFailureCode;
  readonly accountId: CalendarAccountId | null;
}

export type { OrphanSecret } from '../../domain/orphanSecrets';

export type CalendarsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface IcloudFormState {
  /** Compte à reconnecter ; null : nouveau compte. */
  readonly accountId: CalendarAccountId | null;
  readonly username: string;
}

export interface CalendarsState {
  readonly status: CalendarsStatus;
  readonly accounts: readonly CalendarAccount[];
  /** État local de chaque compte (absent : pas encore évalué). */
  readonly states: Readonly<Record<string, CalendarAccountState>>;
  /** Comptes en cours de rafraîchissement (verrou par compte, K-03 critère 7). */
  readonly refreshing: readonly CalendarAccountId[];
  /** Flux OAuth en cours (page de consentement ouverte dans le navigateur). */
  readonly connecting: boolean;
  /** Échec de la feuille de connexion Google (iPhone) ; null : aucun. Ne dépend d'aucun texte libre ni d'aucune URL. */
  readonly googleFailure: GoogleWebAuthFailure | null;
  readonly errorKey: PlainMessageKey | null;
  /** Dernier message d'une action de l'écran (connexion annulée, enregistrement refusé…) ; null : aucun. */
  readonly messageKey: PlainMessageKey | null;
  /** Formulaire iCloud ouvert : nouveau compte ou reconnexion pré-remplie (K-02 critère 6). */
  readonly icloudForm: IcloudFormState | null;
  /**
   * Secrets d'une connexion abandonnée que le coffre n'a pas pu effacer (révocation ou effacement en échec) : ils restent peut-être
   * au coffre de cet appareil ; l'écran Agendas le dit et propose « Réessayer l'effacement » (aucun échec silencieux).
   */
  readonly orphanSecrets: readonly OrphanSecret[];
  load(): Promise<void>;
  connectGoogle(): Promise<ConnectOutcome>;
  connectIcloud(username: string, password: string): Promise<ConnectOutcome>;
  reconnectGoogle(accountId: CalendarAccountId): Promise<ConnectOutcome>;
  /** `username` : identifiant Apple saisi pour un compte reçu d'un autre appareil (sans identifiant sur cet appareil). */
  reconnectIcloud(accountId: CalendarAccountId, password: string, username?: string): Promise<ConnectOutcome>;
  /** ES-06 et K-01 critère 5 : enregistre les agendas affichés et leur espace ; refusé si un agenda affiché n'a pas d'espace. */
  setCalendars(accountId: CalendarAccountId, calendars: readonly CalendarRef[]): Promise<'ok' | 'space-required' | 'error'>;
  removeAccount(accountId: CalendarAccountId): Promise<boolean>;
  /** Rafraîchit un compte si les règles de K-03 l'autorisent ; rend `skipped` sinon. Ne rejette jamais. */
  refresh(accountId: CalendarAccountId, trigger: RefreshTrigger, foreground?: boolean): Promise<'done' | 'skipped'>;
  refreshAll(trigger: RefreshTrigger, foreground?: boolean): Promise<void>;
  /** « Reconnecter » (carte du compte et cadre d'état, A-09 critère 10) : ouvre l'écran Agendas ; Google relance le navigateur, iCloud ouvre le formulaire pré-rempli. */
  requestReconnect(accountId: CalendarAccountId): void;
  openIcloudForm(): void;
  closeIcloudForm(): void;
  clearMessage(): void;
  /** « Réessayer l'effacement » : nouvelle tentative pour chaque secret orphelin ; ceux encore présents restent signalés. */
  retryForgetSecrets(): Promise<void>;
  /** Retire les états A-09 posés par les agendas (arrêt du planificateur, tests). */
  releaseStatuses(): void;
}

const systemTimeZone = (): string => useAppStore.getState().timeZone ?? detectTimeZone() ?? 'UTC';

const isoAt = (ms: number): IsoDateTime => new Date(ms).toISOString() as IsoDateTime;

export const calendarsStore = defineFeatureStore<CalendarsState>((container: AppContainer) => {
  const cursors = new Map<string, ChangeCursor | null>();
  const inFlight = new Set<CalendarAccountId>();
  /** `offline` posé par les agendas : retiré par eux seuls (le réseau de l'appareil gère le sien). */
  let ownsOffline = false;
  const platform = container.calendars;
  const nowMs = (): number => container.clock.nowMs();
  const providerFor = (account: Pick<CalendarAccount, 'provider' | 'tokenRef' | 'username'>) => createProviderFor(account, platform, nowMs, systemTimeZone);
  const deps = { container, providerFor, timeZone: systemTimeZone, cursors };
  const useCases = createCalendarUseCases(container);

  return createStore<CalendarsState>()((set, get) => {
    /** A-09 : « Agenda <nom> déconnecté » + « Reconnecter », et « Hors ligne » quand un compte échoue côté réseau ou serveur. */
    const syncStatuses = (): void => {
      const { accounts, states } = get();
      const map = new Map(Object.entries(states).map(([id, state]) => [id as CalendarAccountId, state]));
      const active = calendarAppStatuses(accounts, map);
      const statusStore = useAppStatusStore.getState();
      // Le compte du bandeau est celui que désigne `calendarAppStatuses` (même règle, `disconnectedAccount`), rapproché par identifiant
      // (ADR 0011 section 8) : le libellé n'identifie plus un compte (vide pour iCloud).
      const target = active.calendarDisconnected ? disconnectedAccount(accounts, map) : undefined;
      statusStore.setStatus('calendarDisconnected', target ? { detail: accountDisplayName(target), onAction: () => get().requestReconnect(target.id) } : null);
      if (active.offline) {
        if (!statusStore.sources.offline) {
          statusStore.setStatus('offline', {});
          ownsOffline = true;
        }
      } else if (ownsOffline) {
        statusStore.setStatus('offline', null);
        ownsOffline = false;
      }
    };

    const setStates = (patch: Readonly<Record<string, CalendarAccountState | null>>): void => {
      const kept = Object.entries(get().states).filter(([id]) => !(id in patch));
      const added = Object.entries(patch).filter((entry): entry is [string, CalendarAccountState] => entry[1] !== null);
      set({ states: Object.fromEntries([...kept, ...added]) });
      syncStatuses();
    };

    const reload = async (): Promise<readonly CalendarAccount[]> => {
      const accounts = await useCases.listAccounts();
      set({ accounts });
      return accounts;
    };

    /**
     * État local du compte (K-01 D1, `localAccountState`) : jamais connecté sur CET appareil (référence locale vide, ligne reçue par la
     * synchro) → « connecté sur un autre appareil », sans interroger le coffre ; sinon le secret de cet appareil existe-t-il ?
     */
    const vaultState = async (account: CalendarAccount, previous: CalendarAccountState | undefined): Promise<CalendarAccountState> => {
      const secretPresent = account.tokenRef === '' ? false : await platform.vault.has(account.tokenRef).catch(() => false);
      return localAccountState({ tokenRef: account.tokenRef, secretPresent }, previous);
    };

    /**
     * Oublie le secret d'un compte : jeton Google révoqué au mieux puis effacé, mot de passe iCloud effacé. Deux tentatives ; rend
     * false si le secret est encore là (coffre indisponible) : l'appelant le signale au lieu de le perdre de vue.
     */
    const discard = async (provider: CalendarProviderKind, tokenRef: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          if (provider === 'google') await platform.oauth.revokeGoogle(tokenRef);
          else await platform.vault.delete(tokenRef);
          return true;
        } catch {
          // Nouvelle tentative, puis échec signalé.
        }
      }
      return false;
    };

    const markConnected = (accountId: CalendarAccountId): void => {
      setStates({ [accountId]: { kind: 'connected', lastSuccessAt: get().states[accountId]?.lastSuccessAt ?? null } });
      void get().refresh(accountId, 'connected');
    };

    /**
     * Connexion et secrets orphelins (calendarsConnect.ts), chargés à la demande : hors du JavaScript de départ (PRD 8). Un échec de
     * chargement n'est pas mémorisé : le geste suivant réessaie.
     */
    let connectModule: Promise<ConnectActions> | null = null;
    const connectActions = (): Promise<ConnectActions> => {
      connectModule ??= import('./calendarsConnect')
        .then(({ createConnectActions }) => createConnectActions({ container, platform, providerFor, useCases, get, set, setStates, reload, discard, markConnected }))
        .catch((error: unknown) => {
          connectModule = null;
          logFailure('calendars', 'connect-module-unavailable');
          throw error;
        });
      return connectModule;
    };
    /** Geste de connexion : module indisponible → échec dit (« Connexion impossible »), jamais silencieux. */
    const connectOrFail = async (run: (actions: ConnectActions) => Promise<ConnectOutcome>): Promise<ConnectOutcome> => {
      const actions = await connectActions().catch(() => null);
      if (!actions) {
        set({ messageKey: FAILURE_KEYS.failed });
        return { ok: false, failure: 'failed' };
      }
      return run(actions);
    };

    return {
      status: 'idle',
      accounts: [],
      states: {},
      refreshing: [],
      connecting: false,
      googleFailure: null,
      errorKey: null,
      messageKey: null,
      icloudForm: null,
      orphanSecrets: [],

      async load() {
        set({ status: 'loading', errorKey: null });
        try {
          const accounts = await reload();
          const previous = get().states;
          const states: Record<string, CalendarAccountState> = {};
          for (const account of accounts) states[account.id] = await vaultState(account, previous[account.id]);
          // Secrets orphelins relus (module à la demande) ; module indisponible : journal, le chargement des comptes continue.
          const actions = await connectActions().catch(() => null);
          if (actions) await actions.restoreOrphans(accounts);
          set({ states, status: 'ready' });
          syncStatuses();
        } catch {
          set({ status: 'error', errorKey: 'calendars.errorLoad' });
        }
      },

      // Connexion et secrets orphelins : module chargé à la demande (hors du JavaScript de départ, PRD 8).
      async connectGoogle() {
        return connectOrFail((actions) => actions.connectGoogle());
      },

      async connectIcloud(username, password) {
        return connectOrFail((actions) => actions.connectIcloud(username, password));
      },

      async reconnectGoogle(accountId) {
        return connectOrFail((actions) => actions.reconnectGoogle(accountId));
      },

      async reconnectIcloud(accountId, password, username) {
        return connectOrFail((actions) => actions.reconnectIcloud(accountId, password, username));
      },

      async setCalendars(accountId, calendars) {
        const result = await (async (): Promise<'ok' | 'space-required' | 'error'> => {
          if (!validateCalendars(calendars, useAppStore.getState().spaces).ok) return 'space-required';
          const previous = get().accounts.find((account) => account.id === accountId);
          if (!previous) return 'error';
          const newlyShown = calendars.some((calendar) => calendar.shown && !previous.calendars.some((old) => old.id === calendar.id && old.shown));
          try {
            // K-01 critère 5 : un agenda décoché disparaît de toutes les vues.
            await useCases.saveCalendars(accountId, calendars);
            await reload();
          } catch {
            return 'error';
          }
          emitEventsChanged(container.data);
          if (newlyShown) void get().refresh(accountId, 'connected');
          return 'ok';
        })();
        set({ messageKey: result === 'ok' ? null : result === 'space-required' ? 'calendars.errorSpaceRequired' : 'calendars.errorSave' });
        return result;
      },

      async removeAccount(accountId) {
        const account = get().accounts.find((candidate) => candidate.id === accountId);
        if (!account) return false;
        // Le secret d'abord (révoqué au mieux pour Google) : même si l'écriture échoue ensuite, plus aucun jeton ne traîne. S'il ne peut
        // pas être effacé, le compte reste (et sa suppression est à refaire) plutôt que de laisser un secret orphelin.
        if (!(await discard(account.provider, account.tokenRef))) {
          set({ messageKey: 'calendars.errorRemoveSecret' });
          return false;
        }
        try {
          await useCases.removeAccount(accountId);
        } catch {
          set({ messageKey: 'calendars.errorRemove' });
          return false;
        }
        for (const key of [...cursors.keys()]) if (key.startsWith(`${accountId}|`)) cursors.delete(key);
        await reload();
        setStates({ [accountId]: null });
        // L'échec de la feuille Google d'un compte supprimé n'a plus d'objet : « Réessayer » relancerait un compte disparu.
        if (get().googleFailure?.accountId === accountId) set({ googleFailure: null });
        emitEventsChanged(container.data);
        return true;
      },

      async refresh(accountId, trigger, foreground = true) {
        const account = get().accounts.find((candidate) => candidate.id === accountId);
        if (!account) return 'skipped';
        // Verrou par compte posé AVANT toute attente : deux appels simultanés ne peuvent pas passer ensemble (K-03 critère 7).
        if (inFlight.has(accountId)) return 'skipped';
        inFlight.add(accountId);
        let started = false;
        try {
          const state = get().states[accountId] ?? (await vaultState(account, undefined));
          if (!shouldRefresh({ state, trigger, now: isoAt(nowMs()), foreground, inFlight: false })) return 'skipped';
          started = true;
          set({ refreshing: [...inFlight] });
          const result = await refreshAccount(deps, accountId);
          // Compte supprimé pendant la lecture : aucun état à (re)créer pour lui.
          if (!('gone' in result) && get().accounts.some((candidate) => candidate.id === accountId)) setStates({ [accountId]: nextAccountState(state, result) });
        } catch {
          // Une exception inattendue ne change pas l'état du compte : les données précédentes restent.
        } finally {
          inFlight.delete(accountId);
          if (started) set({ refreshing: [...inFlight] });
        }
        return started ? 'done' : 'skipped';
      },

      async refreshAll(trigger, foreground = true) {
        await Promise.all(get().accounts.map((account) => get().refresh(account.id, trigger, foreground)));
      },

      requestReconnect(accountId) {
        const account = get().accounts.find((candidate) => candidate.id === accountId);
        if (!account) return;
        useNavigationStore.getState().navigate({ tab: 'settings', screen: 'calendars' });
        set({ messageKey: null });
        if (account.provider === 'google') void get().reconnectGoogle(accountId);
        else set({ icloudForm: { accountId, username: account.username } });
      },

      openIcloudForm() {
        set({ messageKey: null, icloudForm: { accountId: null, username: '' } });
      },

      closeIcloudForm() {
        set({ icloudForm: null });
      },

      async retryForgetSecrets() {
        const actions = await connectActions().catch(() => null);
        if (!actions) set({ messageKey: FAILURE_KEYS.failed });
        else await actions.retryForgetSecrets();
      },

      clearMessage() {
        set({ messageKey: null });
      },

      releaseStatuses() {
        const statusStore = useAppStatusStore.getState();
        statusStore.setStatus('calendarDisconnected', null);
        if (ownsOffline) statusStore.setStatus('offline', null);
        ownsOffline = false;
      },
    };
  });
});
