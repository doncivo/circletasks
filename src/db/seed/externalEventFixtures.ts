import { encodeCalendars, type CalendarProvider, type CalendarRef } from '../../domain/model';
import type { SqlExecutor } from '../driver';

/**
 * Jeu de données de test des agendas externes (S-05) : aucun connecteur n'existe avant K-01 (ordre 2), donc aucune ligne
 * n'est produite par l'app. Ces fonctions insèrent directement en SQL, pour les tests des repositories, des écrans et, via
 * `window.__ctTest` (src/db/testHooks.ts), les e2e. Jamais appelées par une feature.
 */
export interface FixtureAccount {
  readonly id: string;
  readonly provider: CalendarProvider;
  readonly label: string;
  readonly calendars: readonly CalendarRef[];
}

export interface FixtureExternalEvent {
  readonly id: string;
  readonly accountId: string;
  readonly calendarId: string;
  readonly title: string;
  readonly startUtc: string;
  readonly endUtc?: string | null;
  readonly allDay?: boolean;
}

const STAMP = '2026-01-01T00:00:00.000Z';

export async function insertCalendarAccount(db: SqlExecutor, account: FixtureAccount): Promise<void> {
  await db.execute(
    `INSERT INTO calendar_account (id, provider, label, token_ref, calendars, created_at, updated_at, deleted_at, device_id, hlc)
     VALUES (?, ?, ?, '', ?, ?, ?, NULL, 'fixture', '000000000000000-0000-fixture')`,
    [account.id, account.provider, account.label, encodeCalendars(account.calendars), STAMP, STAMP],
  );
}

export async function insertExternalEvent(db: SqlExecutor, event: FixtureExternalEvent): Promise<void> {
  await db.execute(
    `INSERT INTO external_event (id, account_id, calendar_id, external_id, title, start_utc, end_utc, all_day, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [event.id, event.accountId, event.calendarId, `ext-${event.id}`, event.title, event.startUtc, event.endUtc ?? null, event.allDay ? 1 : 0, STAMP],
  );
}
