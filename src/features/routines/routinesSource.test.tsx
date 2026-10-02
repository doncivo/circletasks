import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import type { LocalDate } from '../../domain/types';
import { loadTodayExtras } from '../today/todaySources';
import { mockViewport, renderToday, seedTask } from '../today/testKit';
import { registerRoutinesSource, unregisterRoutinesSource } from './routinesSource';
import { seedLog, seedRoutine, setupRoutines, teardownRoutines, type RoutinesHarness } from './testKit';

// Aujourd'hui : ven. 2 oct. 2026 ; semaine du lun. 28 sept. au dim. 4 oct.
const day = (iso: string) => iso as LocalDate;

describe('Source des routines dans Aujourd’hui (R-01 critère 11, R-03 critère 7, QB-01)', () => {
  let h: RoutinesHarness;

  beforeEach(async () => {
    h = await setupRoutines('203');
    mockViewport(440);
    registerRoutinesSource();
    registerRoutinesSource(); // idempotent : une seule source
  });
  afterEach(async () => {
    unregisterRoutinesSource();
    await teardownRoutines(h);
  });

  it('une routine prévue aujourd’hui apparaît avec « 08:30 · Routine », triée parmi les tâches', async () => {
    await seedRoutine(h, { title: 'Boire de l’eau', time: '08:30' as never });
    await seedTask(h, { title: 'Appeler le notaire', time: '09:00' });
    await seedTask(h, { title: 'Réunion', time: '08:00' });
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Réunion' });
    const titles = Array.from(document.querySelectorAll('.ct-today__list .ct-list-row__title')).map((node) => node.textContent);
    expect(titles).toEqual(['Réunion', 'Boire de l’eau', 'Appeler le notaire']);
    expect(screen.getByText('08:30 · Routine')).toBeInTheDocument();
  });

  it('une routine sans heure vient après les éléments horodatés, sans heure affichée (R-02 critère 3)', async () => {
    await seedRoutine(h, { title: 'Ranger le bureau' });
    await seedTask(h, { title: 'Appeler le notaire', time: '09:00' });
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Appeler le notaire' });
    const titles = Array.from(document.querySelectorAll('.ct-today__list .ct-list-row__title')).map((node) => node.textContent);
    expect(titles).toEqual(['Appeler le notaire', 'Ranger le bureau']);
    expect(screen.getByText('Routine')).toBeInTheDocument(); // sous-ligne sans heure
  });

  it('une routine non prévue ce jour (Sport lun., mer., ven. un mardi) n’apparaît pas', async () => {
    await seedRoutine(h, { title: 'Sport', scheduleType: 'weekdays', weekdays: [1, 3, 5] });
    const tuesday = await loadTodayExtras(h.container, day('2026-09-29'), 'all');
    expect(tuesday.extras.routines).toEqual([]);
    const friday = await loadTodayExtras(h.container, day('2026-10-02'), 'all');
    expect(friday.extras.routines.map((entry) => entry.routine.title)).toEqual(['Sport']);
  });

  it('le filtre d’espace s’applique', async () => {
    await seedRoutine(h, { title: 'Lire 20 minutes', spaceId: SPACE_PERSO_ID });
    expect((await loadTodayExtras(h.container, day('2026-10-02'), SPACE_PERSO_ID)).extras.routines).toHaveLength(1);
    const pro = h.container.data.repos.spaces.listAll().then((spaces) => spaces.find((space) => space.id !== SPACE_PERSO_ID)?.id);
    expect((await loadTodayExtras(h.container, day('2026-10-02'), (await pro) ?? 'all')).extras.routines).toHaveLength(0);
  });

  it('« 3 fois par semaine » validée lun. et mar. : visible mercredi non cochée, absente après le 3e jusqu’au lundi (QB-01, critère 13)', async () => {
    const run = await seedRoutine(h, { title: 'Courir', scheduleType: 'x_per_week', timesPerWeek: 3, startDate: day('2026-09-01') });
    await seedLog(h, run, '2026-09-28');
    await seedLog(h, run, '2026-09-29');
    const wednesday = await loadTodayExtras(h.container, day('2026-09-30'), 'all');
    expect(wednesday.extras.routines).toMatchObject([{ done: false }]);

    await seedLog(h, run, '2026-09-30');
    // Le jour du quota : validée, affichée.
    expect((await loadTodayExtras(h.container, day('2026-09-30'), 'all')).extras.routines).toMatchObject([{ done: true }]);
    for (const date of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
      expect((await loadTodayExtras(h.container, day(date), 'all')).extras.routines).toEqual([]);
    }
    // Lundi suivant : de retour.
    expect((await loadTodayExtras(h.container, day('2026-10-05'), 'all')).extras.routines).toMatchObject([{ done: false }]);
  });

  it('les routines en pause ou archivées n’y figurent pas', async () => {
    await seedRoutine(h, { title: 'En pause', paused: true });
    await seedRoutine(h, { title: 'Archivée', archived: true });
    expect((await loadTodayExtras(h.container, day('2026-10-02'), 'all')).extras.routines).toEqual([]);
  });
});
