import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate, RoutineId } from '../../domain/types';
import { mockViewport, renderRoutines, seedLog, seedRoutine, setupRoutines, teardownRoutines, type RoutinesHarness } from './testKit';

// Aujourd'hui : ven. 2 oct. 2026.
const card = (title: string): HTMLElement => screen.getByRole('heading', { name: title }).closest('article') as HTMLElement;
const WEEK = { from: '2026-09-28' as LocalDate, to: '2026-10-04' as LocalDate };
const CTRL_Z = { key: 'z', code: 'KeyZ', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, editable: false };

describe('QA lot R', () => {
  let h: RoutinesHarness;
  beforeEach(async () => {
    h = await setupRoutines('279');
    mockViewport(440);
  });
  afterEach(() => teardownRoutines(h));

  it('R-03 valider puis Ctrl+Z (raccourci global) retire la validation, rond et compteur repartent', async () => {
    const lit = await seedRoutine(h, { title: 'Faire mon lit' });
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Faire mon lit' });
    fireEvent.click(within(card('Faire mon lit')).getByRole('checkbox', { name: 'Vendredi' }));
    await waitFor(() => expect(within(card('Faire mon lit')).getByRole('checkbox', { name: 'Vendredi, fait' })).toBeChecked());
    await act(async () => void h.container.shortcuts.handle(CTRL_Z));
    await waitFor(async () => expect(await h.container.data.repos.routineLogs.listForRoutine(lit.id as RoutineId, WEEK)).toEqual([]));
    await waitFor(() => expect(within(card('Faire mon lit')).getByRole('checkbox', { name: 'Vendredi' })).not.toBeChecked());
  });

  // R-04 critère 5 : l'écran ne transmet jamais de périodes de pause (RoutineCard.tsx:41 appelle computeStreaks sans `pauses` ;
  // le modèle ne stocke que `paused`). Les jours de pause cassent donc la série après reprise.
  it.fails('R-04 critère 5 : routine mise en pause 5 jours puis reprise, la carte garde la série (DÉMONTRE LE DÉFAUT)', async () => {
    const lit = await seedRoutine(h, { title: 'Faire mon lit' });
    for (const date of ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-30', '2026-10-01']) await seedLog(h, lit, date);
    // Pause du 25 au 29 sept., puis reprise : la série devrait valoir 5 jours.
    await h.container.data.repos.routines.setPaused(lit.id as RoutineId, true);
    await h.container.data.repos.routines.setPaused(lit.id as RoutineId, false);
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Faire mon lit' });
    expect(card('Faire mon lit')).toHaveTextContent('série 5 jours');
  });
});
