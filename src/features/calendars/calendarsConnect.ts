import type { ProviderCalendar } from '../../domain/calendarProvider';
import type { CalendarAccountState } from '../../domain/calendarRefresh';
import { prefillCalendarSpaces } from '../../domain/externalCalendars';
import { newEntityId } from '../../domain/id';
import { orphansOutsideAccounts, parseOrphanSecrets, withOrphan, withoutOrphan, type OrphanSecret } from '../../domain/orphanSecrets';
import type { CalendarAccount, CalendarProviderKind, CalendarRef } from '../../domain/model';
import type { CalendarAccountId } from '../../domain/types';
import { logFailure } from '../../platform';
import { CalendarPlatformError, isWebAuthFailure, type CalendarPlatform } from '../../platform/calendars';
import { useAppStore } from '../app/appStore';
import type { AppContainer } from '../app/container';
import type { CalendarUseCases } from './calendarUseCases';
import { FAILURE_KEYS, type CalendarsState, type ConnectFailure, type ConnectOutcome } from './calendarsStore';
import { tokenRefFor, type createProviderFor } from './providerFactory';

/**
 * Connexion des comptes d'agenda (K-01, K-02) et secrets orphelins, chargés À LA DEMANDE par `calendarsStore` (geste de
 * l'utilisateur, ou premier chargement de l'écran) : hors du JavaScript de départ (PRD 8, seuil de 350 Ko gzip). Même comportement
 * qu'avant le découpage ; aucun secret ici, seulement des références du coffre.
 */

type Get = () => CalendarsState;
type Set = (patch: Partial<CalendarsState>) => void;

export interface ConnectContext {
  readonly container: AppContainer;
  readonly platform: CalendarPlatform;
  readonly providerFor: (account: Pick<CalendarAccount, 'provider' | 'tokenRef' | 'username'>) => ReturnType<typeof createProviderFor>;
  readonly useCases: CalendarUseCases;
  readonly get: Get;
  readonly set: Set;
  readonly setStates: (patch: Readonly<Record<string, CalendarAccountState | null>>) => void;
  readonly reload: () => Promise<readonly CalendarAccount[]>;
  /** Efface un secret (deux tentatives) ; faux s'il est encore au coffre. */
  readonly discard: (provider: CalendarProviderKind, tokenRef: string) => Promise<boolean>;
  readonly markConnected: (accountId: CalendarAccountId) => void;
}

export interface ConnectActions {
  connectGoogle(): Promise<ConnectOutcome>;
  connectIcloud(username: string, password: string): Promise<ConnectOutcome>;
  reconnectGoogle(accountId: CalendarAccountId): Promise<ConnectOutcome>;
  reconnectIcloud(accountId: CalendarAccountId, password: string, username?: string): Promise<ConnectOutcome>;
  retryForgetSecrets(): Promise<void>;
  restoreOrphans(accounts: readonly CalendarAccount[]): Promise<void>;
}

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
    if (isWebAuthFailure(error.code)) return 'web-auth-failed';
  }
  return 'failed';
}

const sameRefs = (a: readonly OrphanSecret[], b: readonly OrphanSecret[]): boolean => a.length === b.length && a.every((orphan, index) => orphan.tokenRef === b[index]?.tokenRef);

const primaryCalendarId = (calendars: readonly ProviderCalendar[]): string => (calendars.find((calendar) => calendar.primary) ?? calendars[0])?.id ?? '';

export function createConnectActions(ctx: ConnectContext): ConnectActions {
  const { container, platform, providerFor, useCases, get, set } = ctx;

  const report = (outcome: ConnectOutcome): ConnectOutcome => {
    // L'échec de la feuille Google a son propre état persistant (code et « Réessayer ») : pas de message passager en double.
    set({ messageKey: outcome.ok || outcome.failure === 'web-auth-failed' ? null : FAILURE_KEYS[outcome.failure] });
    return outcome;
  };

  /** Échec d'une autorisation Google : retient le code de la feuille web (iPhone) ou efface l'état précédent (réussite, annulation, autre échec). */
  const reportAuthorization = (error: unknown, accountId: CalendarAccountId | null): ConnectOutcome => {
    const failure = connectionFailure(error);
    const code = error instanceof CalendarPlatformError && isWebAuthFailure(error.code) ? error.code : null;
    set({ googleFailure: code === null ? null : { code, accountId } });
    return report({ ok: false, failure });
  };

  /** Crée le compte (agendas tous affichés, espace par défaut) puis lance son premier rafraîchissement (K-01 critère 6). */
  const createAccount = async (provider: CalendarProviderKind, accountId: CalendarAccountId, label: string, calendars: readonly ProviderCalendar[], username = ''): Promise<ConnectOutcome> => {
    try {
      await useCases.createAccount({ id: accountId, provider, label, username, tokenRef: tokenRefFor(provider, accountId), calendars: toCalendarRefs(calendars) });
      await ctx.reload();
    } catch {
      return { ok: false, failure: 'failed' };
    }
    ctx.setStates({ [accountId]: { kind: 'connected', lastSuccessAt: null } });
    void get().refresh(accountId, 'connected');
    return { ok: true, accountId };
  };

  /** Écrit les références orphelines dans le réglage LOCAL `calendars.orphanSecrets` (jamais de secret) ; échec : journal à code fixe. */
  const persistOrphans = (list: readonly OrphanSecret[]): Promise<void> =>
    container.data.repos.settings.set('calendars.orphanSecrets', list.length === 0 ? null : list).catch(() => logFailure('calendars', 'orphan-secrets-unwritable'));

  /** Liste des références orphelines, à l'écran et au réglage local (survit à un redémarrage). */
  const setOrphans = async (list: readonly OrphanSecret[]): Promise<void> => {
    if (sameRefs(get().orphanSecrets, list)) return;
    set({ orphanSecrets: list });
    await persistOrphans(list);
  };

  /** Un secret valable vient d'être écrit sous cette référence (connexion réussie) : elle n'est plus orpheline, jamais effacée ensuite. */
  const secretWritten = (tokenRef: string): Promise<void> => setOrphans(withoutOrphan(get().orphanSecrets, tokenRef));

  /**
   * Oublie le secret d'une connexion abandonnée (compte refusé, doublon, écriture impossible). S'il reste au coffre, il est gardé
   * dans `orphanSecrets` : message dédié et « Réessayer l'effacement » sur l'écran Agendas, jamais d'échec silencieux.
   */
  const forget = async (provider: CalendarProviderKind, tokenRef: string): Promise<void> => {
    if (await ctx.discard(provider, tokenRef)) await setOrphans(withoutOrphan(get().orphanSecrets, tokenRef));
    else await setOrphans(withOrphan(get().orphanSecrets, { provider, tokenRef }));
  };

  const actions: ConnectActions = {
    async connectGoogle() {
      if (get().connecting) return { ok: false, failure: 'failed' };
      const accountId = newEntityId<CalendarAccountId>(container.ids);
      const tokenRef = tokenRefFor('google', accountId);
      set({ connecting: true, messageKey: null });
      try {
        try {
          await platform.oauth.authorizeGoogle(tokenRef);
        } catch (error) {
          return reportAuthorization(error, null);
        }
        set({ googleFailure: null });
        await secretWritten(tokenRef);
        const listed = await providerFor({ provider: 'google', tokenRef, username: '' }).listCalendars();
        if (!listed.ok) {
          await forget('google', tokenRef);
          return report({ ok: false, failure: listed.error.kind === 'network' || listed.error.kind === 'server' ? 'google-unreachable' : 'failed' });
        }
        const label = primaryCalendarId(listed.value);
        if (label === '' || get().accounts.some((account) => account.provider === 'google' && account.label === label)) {
          await forget('google', tokenRef);
          return report({ ok: false, failure: label === '' ? 'failed' : 'duplicate' });
        }
        const created = await createAccount('google', accountId, label, listed.value);
        if (!created.ok) await forget('google', tokenRef);
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
      // s'il y en a plusieurs, l'utilisateur choisit lequel par « Connecter ici » sur sa carte.
      const received = get().accounts.filter((account) => account.provider === 'icloud' && account.username === '' && account.tokenRef === '');
      if (received.length > 1) return { ok: false, failure: 'icloud-choose-account' };
      const only = received[0];
      if (only) return actions.reconnectIcloud(only.id, password, appleId);
      try {
        await platform.vault.set(tokenRef, password);
      } catch {
        return { ok: false, failure: 'failed' };
      }
      await secretWritten(tokenRef);
      const listed = await providerFor({ provider: 'icloud', tokenRef, username: appleId }).listCalendars();
      if (!listed.ok) {
        await forget('icloud', tokenRef);
        return { ok: false, failure: listed.error.kind === 'unauthorized' ? 'icloud-invalid' : 'icloud-unreachable' };
      }
      const created = await createAccount('icloud', accountId, '', listed.value, appleId);
      if (!created.ok) {
        await forget('icloud', tokenRef);
        return created;
      }
      set({ icloudForm: null, messageKey: null });
      return created;
    },

    async reconnectGoogle(accountId) {
      const account = get().accounts.find((candidate) => candidate.id === accountId);
      if (!account || get().connecting) return { ok: false, failure: 'failed' };
      set({ connecting: true, messageKey: null });
      // Compte reçu par la synchro, jamais connecté sur CET appareil (« Connecter ici ») : nouvelle référence du coffre propre à cet
      // appareil (colonne locale `token_ref`, jamais publiée), comme pour iCloud ; jamais d'autorisation sur une référence vide.
      const incomplete = account.tokenRef === '';
      const tokenRef = incomplete ? tokenRefFor('google', accountId) : account.tokenRef;
      // Même compte Google déjà connecté ici sur une autre ligne : pas de second jeton pour lui.
      if (incomplete && get().accounts.some((other) => other.id !== accountId && other.provider === 'google' && other.label === account.label && other.tokenRef !== '')) {
        set({ connecting: false });
        return report({ ok: false, failure: 'duplicate' });
      }
      try {
        try {
          await platform.oauth.authorizeGoogle(tokenRef);
        } catch (error) {
          return reportAuthorization(error, accountId);
        }
        set({ googleFailure: null });
        await secretWritten(tokenRef);
        if (incomplete) {
          // Le compte autorisé doit être celui de la ligne reçue (libellé = agenda principal, comme à la connexion) ; sinon le jeton
          // est révoqué et effacé, rien n'est rattaché.
          const listed = await providerFor({ provider: 'google', tokenRef, username: '' }).listCalendars();
          const primary = listed.ok ? primaryCalendarId(listed.value) : '';
          // Agenda principal introuvable (liste vide) : rien ne prouve que c'est le bon compte, même si la ligne n'a pas de libellé.
          if (!listed.ok || primary === '' || primary !== account.label) {
            await forget('google', tokenRef);
            const failure: ConnectFailure = !listed.ok ? (listed.error.kind === 'network' || listed.error.kind === 'server' ? 'google-unreachable' : 'failed') : primary === '' ? 'failed' : 'google-other-account';
            return report({ ok: false, failure });
          }
          try {
            await container.data.repos.calendarAccounts.setLocalCredentials(accountId, { username: '', tokenRef });
            await ctx.reload();
          } catch {
            await forget('google', tokenRef);
            return report({ ok: false, failure: 'failed' });
          }
        }
        ctx.markConnected(accountId);
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
      await secretWritten(account.tokenRef);
      const listed = await providerFor(account).listCalendars();
      if (!listed.ok) {
        if (listed.error.kind === 'unauthorized') await forget('icloud', account.tokenRef);
        return { ok: false, failure: listed.error.kind === 'unauthorized' ? 'icloud-invalid' : 'icloud-unreachable' };
      }
      if (incomplete) {
        try {
          await container.data.repos.calendarAccounts.setLocalCredentials(accountId, { username: appleId, tokenRef: account.tokenRef });
          await ctx.reload();
        } catch {
          return { ok: false, failure: 'failed' };
        }
      }
      ctx.markConnected(accountId);
      set({ icloudForm: null, messageKey: null });
      return { ok: true, accountId };
    },

    async retryForgetSecrets() {
      // Jamais la référence d'un compte de cet appareil : son secret est valable (reconnexion réussie sous la même référence).
      const pending = orphansOutsideAccounts(get().orphanSecrets, get().accounts.map((account) => account.tokenRef));
      const remaining: OrphanSecret[] = [];
      for (const orphan of pending) if (!(await ctx.discard(orphan.provider, orphan.tokenRef))) remaining.push(orphan);
      await setOrphans(remaining);
    },

    /** Au chargement : orphelins relus du réglage, gardés seulement s'ils sont encore au coffre et ne sont la référence d'aucun compte. */
    async restoreOrphans(accounts) {
      let stored: OrphanSecret[] = [];
      try {
        stored = parseOrphanSecrets(await container.data.repos.settings.get('calendars.orphanSecrets'));
      } catch {
        logFailure('calendars', 'orphan-secrets-unreadable');
      }
      const merged = get().orphanSecrets.reduce((list, orphan) => withOrphan(list, orphan), stored);
      const present: OrphanSecret[] = [];
      for (const orphan of orphansOutsideAccounts(merged, accounts.map((account) => account.tokenRef))) {
        // Coffre illisible : la référence reste signalée (rien n'est oublié sur un doute).
        if (await platform.vault.has(orphan.tokenRef).catch(() => true)) present.push(orphan);
      }
      set({ orphanSecrets: present });
      if (!sameRefs(stored, present)) await persistOrphans(present);
    },
  };
  return actions;
}
