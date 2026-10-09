import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLogJournal } from '../../../platform/desktop/log';
import { createLogJournal, createMemoryLogTransport } from '../../../platform/logs';
import { runRemindersPass } from '../../calendars/appleReminders/remindersPass';
import { PERSO, setupRemindersHarness, type RemindersHarness } from '../../calendars/appleReminders/testKit';

const SENTINEL = 'TITRE-SECRET-123';

/**
 * I-04 critère 6, revue du lot F : messages RÉELS d'un module qui manipule des titres (passage des Rappels Apple, K-05) : rappels et listes
 * porteurs de la sentinelle, écritures refusées par le plugin ; le journal ne contient jamais la sentinelle.
 */
describe('I-04 critère 6 : sentinelle et passage des Rappels Apple', () => {
  const transport = createMemoryLogTransport();
  const journal = createLogJournal(transport, { document: null, window: null });
  installLogJournal(journal);
  let h: RemindersHarness;

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h = await setupRemindersHarness('12');
    await h.showList({ id: 'L-secret', name: `Liste ${SENTINEL}`, spaceId: PERSO });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  it('échecs du plugin pendant un passage avec des titres sentinelles : aucune trace de la sentinelle', async () => {
    h.reminders.add({ listId: 'L-secret', title: `${SENTINEL} acheter`, due: null });
    h.reminders.failNext('fetch', 'store-unavailable');
    await runRemindersPass(h.container, 'full');
    h.reminders.failNext('upsert', 'write-failed', 3);
    await runRemindersPass(h.container, 'full');
    await journal.flush();
    expect(transport.stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(transport.stored)).not.toContain(SENTINEL);
    expect(JSON.stringify(await journal.read())).not.toContain(SENTINEL);
  });
});
