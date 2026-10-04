import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setFormatPrefs } from '../../i18n/formatPrefs';
import { useAppStore } from '../app/appStore';
import type { KeyInput } from '../app/shortcuts';
import { mockViewport, renderWeek, setupWeek, teardownWeek, type WeekHarness } from './testKit';

const ctrl = (k: 'ArrowLeft' | 'ArrowRight'): KeyInput => ({ key: k, code: k, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, editable: false });
const dates = (): (string | null)[] => [...document.querySelectorAll('.ct-week-day')].map((el) => el.getAttribute('data-date'));

describe('P-03 QA : Semaine, navigation et passage d’année avec un autre premier jour (critère 2)', () => {
  let h: WeekHarness;
  afterEach(async () => {
    setFormatPrefs({ firstWeekday: 'monday' });
    useAppStore.setState({ timeZone: null });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownWeek(h);
  });

  it('dimanche : Ctrl+→ puis Ctrl+← avancent de sept jours depuis un dimanche', async () => {
    h = await setupWeek('a31');
    mockViewport(1440);
    setFormatPrefs({ firstWeekday: 'sunday' });
    renderWeek(h.container);
    await screen.findByText('Semaine 40');
    expect(dates()[0]).toBe('2026-09-27');
    act(() => {
      h.container.shortcuts.handle(ctrl('ArrowRight'));
    });
    await screen.findByText('Semaine 41');
    expect(dates()[0]).toBe('2026-10-04');
    expect(dates()[6]).toBe('2026-10-10');
    act(() => {
      h.container.shortcuts.handle(ctrl('ArrowLeft'));
    });
    await screen.findByText('Semaine 40');
    expect(dates()[0]).toBe('2026-09-27');
  });

  it('samedi : passage d’année, du samedi 26 déc. 2026 au vendredi 1er janv. 2027, puis semaine suivante', async () => {
    h = await setupWeek('a32', '2026-12-30T10:00:00.000Z');
    useAppStore.getState().setTimeZone('Europe/Paris');
    mockViewport(1440);
    setFormatPrefs({ firstWeekday: 'saturday' });
    renderWeek(h.container);
    await screen.findByText('Semaine 53');
    expect(dates()).toEqual(['2026-12-26', '2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01']);
    act(() => {
      h.container.shortcuts.handle(ctrl('ArrowRight'));
    });
    await screen.findByText('Semaine 1');
    expect(dates()[0]).toBe('2027-01-02');
    expect(dates()[6]).toBe('2027-01-08');
  });

  it('dimanche : passage d’année, du dimanche 27 déc. 2026 au samedi 2 janv. 2027', async () => {
    h = await setupWeek('a33', '2026-12-30T10:00:00.000Z');
    useAppStore.getState().setTimeZone('Europe/Paris');
    mockViewport(1440);
    setFormatPrefs({ firstWeekday: 'sunday' });
    renderWeek(h.container);
    await screen.findByText('Semaine 53');
    expect(dates()[0]).toBe('2026-12-27');
    expect(dates()[6]).toBe('2027-01-02');
  });
});
