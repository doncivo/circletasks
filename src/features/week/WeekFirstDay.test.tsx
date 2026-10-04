import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFormatPrefs } from '../../i18n/formatPrefs';
import { mockViewport, renderWeek, setupWeek, teardownWeek, type WeekHarness } from './testKit';

/** Aujourd'hui du harnais : ven. 2 oct. 2026. */
const dates = (): (string | null)[] => [...document.querySelectorAll('.ct-week-day')].map((el) => el.getAttribute('data-date'));

describe('Semaine : premier jour réglable (P-03 critère 2)', () => {
  let h: WeekHarness;
  beforeEach(async () => {
    h = await setupWeek('4a3');
    mockViewport(1440);
  });
  afterEach(async () => {
    setFormatPrefs({ firstWeekday: 'monday' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownWeek(h);
  });

  it('lundi par défaut', async () => {
    renderWeek(h.container);
    await screen.findByText('Semaine 40');
    expect(dates()[0]).toBe('2026-09-28');
    expect(dates()[6]).toBe('2026-10-04');
  });

  it('dimanche : la semaine courante va du dimanche 27 septembre au samedi 3 octobre', async () => {
    setFormatPrefs({ firstWeekday: 'sunday' });
    renderWeek(h.container);
    await screen.findByText('Semaine 40');
    expect(dates()).toEqual(['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']);
  });

  it('samedi : du samedi 26 septembre au vendredi 2 octobre', async () => {
    setFormatPrefs({ firstWeekday: 'saturday' });
    renderWeek(h.container);
    await screen.findByText('Semaine 40');
    expect(dates()[0]).toBe('2026-09-26');
    expect(dates()[6]).toBe('2026-10-02');
  });
});
