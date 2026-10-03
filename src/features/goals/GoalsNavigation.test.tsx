import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useNavigationStore } from '../app/navigation';
import { mockViewport, renderToday, setupToday, teardownToday, type TodayHarness } from '../today/testKit';

describe.each([
  ['iPhone', 440],
  ['PC', 1280],
])('Accès à l’écran Objectif depuis Aujourd’hui (OB-01 critère 1), %s', (_name, width) => {
  let h: TodayHarness;

  beforeEach(async () => {
    h = await setupToday(width < 1024 ? '311' : '312');
    mockViewport(width);
  });
  afterEach(() => teardownToday(h));

  it('l’icône cible « Objectif de la semaine » ouvre l’écran Objectif', async () => {
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Objectif de la semaine' }));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'tasks', screen: 'goals' });
  });

  it('ouvrir l’écran Objectif ferme la fiche détail ouverte', async () => {
    renderToday(h.container);
    useNavigationStore.getState().openDetail({ type: 'goal', id: 'x' as never });
    fireEvent.click(await screen.findByRole('button', { name: 'Objectif de la semaine' }));
    expect(useNavigationStore.getState().detail).toBeNull();
  });
});
