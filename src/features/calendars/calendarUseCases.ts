import type { NewCalendarAccount } from '../../db/repositories';
import type { CalendarAccount, CalendarRef } from '../../domain/model';
import type { CalendarAccountId } from '../../domain/types';
import type { AppContainer } from '../app/container';

/**
 * Comptes d'agendas externes (K-01, ES-06) : seul point d'écriture des comptes et de leurs événements pour le store des agendas.
 * Le store garde l'état local (connecté, à reconnecter), les secrets du coffre et les notifications d'écran ; ces cas d'usage ne font
 * que lire et écrire en base. Contrat : chaque méthode rejette si la base échoue (rien n'est écrit pour les écritures groupées).
 */
export interface CalendarUseCases {
  /** Comptes non supprimés, triés par libellé. */
  listAccounts(): Promise<CalendarAccount[]>;
  /** K-01 critère 6 : enregistre un compte nouvellement connecté. */
  createAccount(account: NewCalendarAccount): Promise<CalendarAccount>;
  /**
   * ES-06 et K-01 critère 5 : remplace les agendas du compte (déjà validés par `validateCalendars`) et, dans la même transaction,
   * retire les événements des agendas décochés (ils disparaissent de toutes les vues).
   */
  saveCalendars(accountId: CalendarAccountId, calendars: readonly CalendarRef[]): Promise<void>;
  /** K-01 critère 8 : suppression logique du compte et de ses événements, dans une transaction. Le secret est effacé avant par l'appelant. */
  removeAccount(accountId: CalendarAccountId): Promise<void>;
}

export type CalendarDeps = Pick<AppContainer, 'data'>;

export function createCalendarUseCases(deps: CalendarDeps): CalendarUseCases {
  return {
    listAccounts: () => deps.data.repos.calendarAccounts.listAll(),
    createAccount: (account) => deps.data.repos.calendarAccounts.create(account),
    async saveCalendars(accountId, calendars) {
      await deps.data.transaction(async (repos) => {
        await repos.calendarAccounts.updateCalendars(accountId, calendars);
        for (const calendar of calendars) if (!calendar.shown) await repos.externalEvents.deleteForCalendar(accountId, calendar.id);
      });
    },
    async removeAccount(accountId) {
      await deps.data.transaction(async (repos) => {
        await repos.calendarAccounts.softDelete(accountId);
        await repos.externalEvents.deleteForAccount(accountId);
      });
    },
  };
}
