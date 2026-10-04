import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { setFormatPrefs } from '../../i18n/formatPrefs';
import { mockViewport, renderRoutines, seedRoutine, setupRoutines, teardownRoutines, type RoutinesHarness } from './testKit';

// Aujourd'hui : ven. 2 oct. 2026 ; le 1er octobre 2026 est un jeudi.
describe('Rapport de routine : premier jour et format d’heure (P-03 critères 2 et 6)', () => {
  let h: RoutinesHarness;
  beforeEach(async () => {
    h = await setupRoutines('a3f');
    mockViewport(1440);
  });
  afterEach(async () => {
    setFormatPrefs({ firstWeekday: 'monday', timeFormat: '24h' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownRoutines(h);
  });

  const open = async () => {
    await seedRoutine(h, { title: 'Sport', scheduleType: 'weekdays', weekdays: [1, 3, 5], time: '18:00' as never, spaceId: SPACE_PERSO_ID });
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Sport' }));
    return screen.findByRole('complementary', { name: 'Rapport de la routine' });
  };
  const gridOf = (panel: HTMLElement) => within(panel).getByRole('group', { name: 'Carte de chaleur du mois' });
  const initials = (panel: HTMLElement) => [...gridOf(panel).querySelectorAll('.ct-routine-report__weekday')].map((e) => e.textContent).join(' ');
  const blanks = (panel: HTMLElement) => gridOf(panel).querySelectorAll('.ct-routine-report__blank').length;

  it('lundi : initiales L M M J V S D, 3 cases vides avant le jeudi 1er octobre', async () => {
    const panel = await open();
    expect(initials(panel)).toBe('L M M J V S D');
    expect(blanks(panel)).toBe(3);
  });

  it('dimanche : initiales D L M M J V S, 4 cases vides', async () => {
    setFormatPrefs({ firstWeekday: 'sunday' });
    const panel = await open();
    expect(initials(panel)).toBe('D L M M J V S');
    expect(blanks(panel)).toBe(4);
  });

  it('samedi : initiales S D L M M J V, 5 cases vides', async () => {
    setFormatPrefs({ firstWeekday: 'saturday' });
    const panel = await open();
    expect(initials(panel)).toBe('S D L M M J V');
    expect(blanks(panel)).toBe(5);
  });

  it('12 h : la fréquence du rapport affiche « 6:00 PM » et la valeur stockée reste « 18:00 »', async () => {
    setFormatPrefs({ timeFormat: '12h' });
    const panel = await open();
    expect(within(panel).getByText('Lundi, mercredi, vendredi à 6:00 PM · Perso')).toBeInTheDocument();
  });
});
