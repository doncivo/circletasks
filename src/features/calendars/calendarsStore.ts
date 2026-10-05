import { createStore } from 'zustand';
import type { ChangeCursor, ProviderCalendar } from '../../domain/calendarProvider';
import { calendarAppStatuses, nextAccountState, shouldRefresh, type CalendarAccountState, type RefreshTrigger } from '../../domain/calendarRefresh';
import { prefillCalendarSpaces, validateCalendars } from '../../domain/externalCalendars';
import { newEntityId } from '../../domain/id';
import type { CalendarAccount, CalendarProviderKind, CalendarRef } from '../../domain/model';
import type { CalendarAccountId, IsoDateTime } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { detectTimeZone } from '../../platform';
import { CalendarPlatformError } from '../../platform/calendars';
import { useAppStatusStore } from '../app/appStatus';
import { useAppStore } from '../app/appStore';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { useNavigationStore } from '../app/navigation';
import { emitEventsChanged } from '../events/eventEvents';
import { createCalendarUseCases } from './calendarUseCases';
import { accountDisplayName } from './accountName';
import { createProviderFor, tokenRefFor } from './providerFactory';
import { refreshAccount } from './refreshUseCase';

/**
 * Comptes d'agendas externes (K-01, K-02, K-03) : liste, connexion, choix des agendas et de leur espace (ES-06), rafraîchissement,
 * suppression. L'état d'un compte (connecté, à reconnecter, erreur) est LOCAL à l'appareil et non persistant : il est recalculé au
 * chargement (secret absent du coffre de CET appareil : « à reconnecter », K-01 D1) puis suit les résultats réseau. Aucun secret n'entre
 * dans ce store : seule une référence du coffre (`tokenRef`) existe côté interface.
 */

export type ConnectFailure = 'cancelled' | 'not-configured' | 'failed' | 'duplicate' | 'icloud-invalid' | 'icloud-unreachable' | 'google-unreachable' | 'icloud-choose-account';
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
};

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
  readonly errorKey: PlainMessageKey | null;
  /** Dernier message d'une action de l'écran (connexion annulée, enregistrement refusé…) ; null : aucun. */
  readonly messageKey: PlainMessageKey | null;
  /** Formulaire iCloud ouvert : nouveau compte ou reconnexion pré-remplie (K-02 critère 6). */
  readonly icloudForm: IcloudFormState | null;
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
  /** Retire les états A-09 posés par les agendas (arrêt du planificateur, tests). */
  releaseStatuses(): void;
}

const systemTimeZone = (): string => useAppStore.getState().timeZone ?? detectTimeZone() ?? 'UTC';

const isoAt = (ms: number): IsoDateTime => new Date(ms).toISOString() as IsoDateTime;

/** Agendas du fournisseur → agendas du compte : tous affichés, rattachés à l'espace par défaut (ES-06 critère 5, T-01 : Pro). */
function toCalendarRefs(calendars: readonly ProviderCalendar[]): CalendarRef[] {
  return prefillCalendarSpaces(
    calendars.map((calendar) => ({ id: calendar.id, name: calendar.name, spaceId: null, shown: true })),
    useAppStore.getState().spaces,
  );
}

function connectionFailure(error: unknown): ConnectFailure {
  if (error instanceof CalendarPlatformError) {
    if (error.code === 'cancelled') return 'cancelled';
    if (error.code === 'config-missing') return 'not-configured';
  }
  return 'failed';
}

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
      const disconnected = active.calendarDisconnected;
      // Rapprochement par identifiant de compte (ADR 0011 section 8) : le libellé n'identifie plus un compte (vide pour iCloud).
      const target = disconnected ? accounts.find((account) => map.get(account.id)?.kind === 'reconnect-required') : undefined;
      statusStore.setStatus('calendarDisconnected', disconnected && target ? { detail: accountDisplayName(target), onAction: () => get().requestReconnect(target.id) } : null);
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

    /** Le secret de CET appareil existe-t-il ? Sinon le compte est « à reconnecter » (K-01 D1). */
    const vaultState = async (account: CalendarAccount, previous: CalendarAccountState | undefined): Promise<CalendarAccountState> => {
      const present = await platform.vault.has(account.tokenRef).catch(() => false);
      if (!present) return { kind: 'reconnect-required', lastSuccessAt: previous?.lastSuccessAt ?? null };
      return previous && previous.kind !== 'reconnect-required' ? previous : { kind: 'connected', lastSuccessAt: previous?.lastSuccessAt ?? null };
    };

    const report = (outcome: ConnectOutcome): ConnectOutcome => {
      set({ messageKey: outcome.ok ? null : FAILURE_KEYS[outcome.failure] });
      return outcome;
    };

    /** Crée le compte (agendas tous affichés, espace par défaut) puis lance son premier rafraîchissement (K-01 critère 6). */
    const createAccount = async (provider: CalendarProviderKind, accountId: CalendarAccountId, label: string, calendars: readonly ProviderCalendar[], username = ''): Promise<ConnectOutcome> => {
      try {
        await useCases.createAccount({ id: accountId, provider, label, username, tokenRef: tokenRefFor(provider, accountId), calendars: toCalendarRefs(calendars) });
        await reload();
      } catch {
        return { ok: false, failure: 'failed' };
      }
      setStates({ [accountId]: { kind: 'connected', lastSuccessAt: null } });
      void get().refresh(accountId, 'connected');
      return { ok: true, accountId };
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

    return {
      status: 'idle',
      accounts: [],
      states: {},
      refreshing: [],
      connecting: false,
      errorKey: null,
      messageKey: null,
      icloudForm: null,

      async load() {
        set({ status: 'loading', errorKey: null });
        try {
          const accounts = await reload();
          const previous = get().states;
          const states: Record<string, CalendarAccountState> = {};
          for (const account of accounts) states[account.id] = await vaultState(account, previous[account.id]);
          set({ states, status: 'ready' });
          syncStatuses();
        } catch {
          set({ status: 'error', errorKey: 'calendars.errorLoad' });
        }
      },

      async connectGoogle() {
        if (get().connecting) return { ok: false, failure: 'failed' };
        const accountId = newEntityId<CalendarAccountId>(container.ids);
        const tokenRef = tokenRefFor('google', accountId);
        set({ connecting: true, messageKey: null });
        try {
          try {
            await platform.oauth.authorizeGoogle(tokenRef);
          } catch (error) {
            return report({ ok: false, failure: connectionFailure(error) });
          }
          const listed = await providerFor({ provider: 'google', tokenRef, username: '' }).listCalendars();
          if (!listed.ok) {
            await discard('google', tokenRef);
            return report({ ok: false, failure: listed.error.kind === 'network' || listed.error.kind === 'server' ? 'google-unreachable' : 'failed' });
          }
          const label = (listed.value.find((calendar) => calendar.primary) ?? listed.value[0])?.id ?? '';
          if (label === '' || get().accounts.some((account) => account.provider === 'google' && account.label === label)) {
            await discard('google', tokenRef);
            return report({ ok: false, failure: label === '' ? 'failed' : 'duplicate' });
          }
          const created = await createAccount('google', accountId, label, listed.value);
          if (!created.ok) await discard('google', tokenRef);
          return report(created);
        } finally {
          set({ connecting: false });
        }
      },

      async connectIcloud(username, password) {
        const accountId = newEntityId<CalendarAccountId>(container.ids);
        const tokenRef = tokenRefFor('icloud', accountId);
        const appleId = username.trim();
        if (appleId === '' || password === '') return { ok: false, failure: 'icloud-invalid' };
        // Doublon contrôlé sur l'identifiant Apple de cet appareil (`username`, colonne locale ; ADR 0011 section 8).
        if (get().accounts.some((account) => account.provider === 'icloud' && account.username.toLowerCase() === appleId.toLowerCase())) return { ok: false, failure: 'duplicate' };
        // Compte iCloud reçu d'un autre appareil, sans identifiant ni secret ici : on le complète au lieu d'en créer un second ;
        // s'il y en a plusieurs, l'utilisateur choisit lequel par « Reconnecter » sur sa carte.
        const received = get().accounts.filter((account) => account.provider === 'icloud' && account.username === '' && account.tokenRef === '');
        if (received.length > 1) return { ok: false, failure: 'icloud-choose-account' };
        const only = received[0];
        if (only) return get().reconnectIcloud(only.id, password, appleId);
        const label = '';
        try {
          await platform.vault.set(tokenRef, password);
        } catch {
          return { ok: false, failure: 'failed' };
        }
        const listed = await providerFor({ provider: 'icloud', tokenRef, username: appleId }).listCalendars();
        if (!listed.ok) {
          await discard('icloud', tokenRef);
          return { ok: false, failure: listed.error.kind === 'unauthorized' ? 'icloud-invalid' : 'icloud-unreachable' };
        }
        const created = await createAccount('icloud', accountId, label, listed.value, appleId);
        if (!created.ok) {
          await discard('icloud', tokenRef);
          return created;
        }
        set({ icloudForm: null, messageKey: null });
        return created;
      },

      async reconnectGoogle(accountId) {
        const account = get().accounts.find((candidate) => candidate.id === accountId);
        if (!account || get().connecting) return { ok: false, failure: 'failed' };
        set({ connecting: true, messageKey: null });
        try {
          try {
            await platform.oauth.authorizeGoogle(account.tokenRef);
          } catch (error) {
            return report({ ok: false, failure: connectionFailure(error) });
          }
          markConnected(accountId);
          return report({ ok: true, accountId });
        } finally {
          set({ connecting: false });
        }
      },

      async reconnectIcloud(accountId, password, username) {
        const found = get().accounts.find((candidate) => candidate.id === accountId);
        if (!found || password === '') return { ok: false, failure: 'icloud-invalid' };
        // Compte reçu par la synchro : identifiant Apple saisi ici et référence du coffre propre à cet appareil (colonnes locales).
        const incomplete = found.username === '' || found.tokenRef === '';
        const appleId = (found.username !== '' ? found.username : (username ?? '')).trim();
        if (appleId === '') return { ok: false, failure: 'icloud-invalid' };
        const account = { ...found, username: appleId, tokenRef: found.tokenRef !== '' ? found.tokenRef : tokenRefFor('icloud', accountId) };
        try {
          await platform.vault.set(account.tokenRef, password);
        } catch {
          return { ok: false, failure: 'failed' };
        }
        const listed = await providerFor(account).listCalendars();
        if (!listed.ok) {
          if (listed.error.kind === 'unauthorized') await platform.vault.delete(account.tokenRef).catch(() => undefined);
          return { ok: false, failure: listed.error.kind === 'unauthorized' ? 'icloud-invalid' : 'icloud-unreachable' };
        }
        if (incomplete) {
          try {
            await container.data.repos.calendarAccounts.setLocalCredentials(accountId, { username: appleId, tokenRef: account.tokenRef });
            await reload();
          } catch {
            return { ok: false, failure: 'failed' };
          }
        }
        markConnected(accountId);
        set({ icloudForm: null, messageKey: null });
        return { ok: true, accountId };
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
