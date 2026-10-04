import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import type { SqlRow } from '../../db/driver';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { startCaldavSim, startGoogleSim, type CaldavSim, type CaldavSimOptions, type GoogleSim, type GoogleSimOptions } from '../../../tests/sim';
import { createMemoryCalendarPlatform, simulatorEndpoints, type MemorySecretVault } from '../../platform/calendars';
import { useAppStatusStore } from '../app/appStatus';
import { useAppStore } from '../app/appStore';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { calendarsStore } from './calendarsStore';

/**
 * Banc d'essai des agendas (K-01 à K-04) : base SQLite en mémoire, conteneur, plateforme en mémoire branchée sur les simulateurs
 * Google et CalDAV (aucun compte réel), horloge manuelle (mer. 23 sept. 2026 10:00 UTC par défaut : les fixtures des simulateurs sont
 * de septembre et octobre 2026).
 */
export interface CalendarHarness {
  readonly db: TestDb;
  readonly container: AppContainer;
  readonly google: GoogleSim;
  readonly caldav: CaldavSim;
  readonly vault: MemorySecretVault;
  close(): Promise<void>;
}

export interface CalendarHarnessOptions {
  readonly startAt?: string;
  readonly google?: GoogleSimOptions;
  readonly caldav?: CaldavSimOptions;
  /** Sans ID client OAuth : « Google n'est pas configuré ». */
  readonly noGoogleClient?: boolean;
}

export async function setupCalendarHarness(deviceSuffix: string, options: CalendarHarnessOptions = {}): Promise<CalendarHarness> {
  const device = asEntityId<DeviceId>(`70000000-0000-4000-8000-0000000${deviceSuffix.padStart(5, '0')}`);
  const db = await openTestDb(device, options.startAt ?? '2026-09-23T10:00:00.000Z');
  const google = await startGoogleSim(options.google);
  const caldav = await startCaldavSim(options.caldav);
  const platform = createMemoryCalendarPlatform(simulatorEndpoints(google.baseUrl, caldav.baseUrl), {
    googleClientId: options.noGoogleClient ? undefined : google.clientId,
    nowSeconds: () => Math.floor(db.clock.nowMs() / 1000),
  });
  const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: device }), data: db.data, calendars: platform });
  useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
  useAppStore.getState().setTimeZone('Europe/Paris');
  return {
    db,
    container,
    google,
    caldav,
    vault: platform.memoryVault,
    close: async () => {
      calendarsStore.get(container).getState().releaseStatuses();
      useAppStore.setState({ spaceFilter: 'all', spaces: [], projects: [], projectFilter: null, day: null, timeZone: null });
      useAppStatusStore.setState({ sources: {} });
      useNavigationStore.setState(INITIAL_NAVIGATION);
      await Promise.all([google.close(), caldav.close()].map((closing) => closing.catch(() => undefined)));
      await db.close();
    },
  };
}

/** Texte de toute la base (colonnes texte de chaque table) : vérifie qu'aucun secret n'y a été écrit. */
export async function dumpDatabaseText(db: TestDb): Promise<string> {
  const tables = await db.driver.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_index%'");
  const parts: string[] = [];
  for (const { name } of tables) {
    const rows = await db.driver.select<SqlRow>(`SELECT * FROM ${name}`);
    for (const row of rows) parts.push(JSON.stringify(row));
  }
  return parts.join('\n');
}
