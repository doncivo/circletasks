import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../domain/localDate';
import type { Task } from '../../domain/model';
import type { ProjectId } from '../../domain/types';
import { newEntityId } from '../../domain/id';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { setFormatPrefs } from '../../i18n/formatPrefs';
import { useAppStore } from '../app/appStore';
import { mockViewport, renderToday, setupToday, teardownToday, type TodayHarness } from '../today/testKit';

/** Cas limites clavier, format 12 h (P-03) et faux positifs de date (Q-06, Q-02), champ d'ajout d'Aujourd'hui. */
describe('Capture rapide : cas limites (Q-06, Q-02, P-03)', () => {
  let h: TodayHarness;

  beforeEach(async () => {
    mockViewport(1440);
    h = await setupToday('a606e');
    const repos = h.container.data.repos;
    const mission = await repos.projects.create({ id: newEntityId<ProjectId>(h.container.ids), spaceId: SPACE_PRO_ID, name: 'Mission', color: '#2F6B7A' as never, archived: false, sortOrder: 1 });
    useAppStore.getState().setProjects([mission]);
    renderToday(h.container);
  });

  afterEach(async () => {
    setFormatPrefs({ timeFormat: '24h' });
    await teardownToday(h);
  });

  const field = (): HTMLInputElement => screen.getByLabelText('Nouvelle tâche');
  const type = (value: string): void => {
    fireEvent.change(field(), { target: { value } });
  };
  const submit = (): void => {
    fireEvent.submit(field().closest('form') as HTMLFormElement);
  };
  const created = async (): Promise<Task[]> => [
    ...(await h.container.data.repos.tasks.listForDay(h.today, 'all')),
    ...(await h.container.data.repos.tasks.listForDay(addDays(h.today, 1), 'all')),
  ];

  it('Q-02 P-03 : en 12 h la pastille affiche l’heure en 12 h ; la tâche garde 10:00', async () => {
    setFormatPrefs({ timeFormat: '12h' });
    await screen.findByRole('heading', { level: 1 });
    type('Appeler le notaire demain 10h');
    const group = await screen.findByRole('group', { name: 'Ce qui sera appliqué' });
    expect(within(group).getByText(/^demain · 10:00\s?AM$/i)).toBeInTheDocument();
    submit();
    await waitFor(async () => expect((await created()).length).toBe(1));
    expect((await created())[0]).toMatchObject({ title: 'Appeler le notaire', time: '10:00' });
  });

  it('Q-06 critère 2 : ↓ puis ↑ déplace la sélection, Entrée choisit la ligne active', async () => {
    await screen.findByRole('heading', { level: 1 });
    type('#');
    await screen.findByRole('listbox');
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(field()).toHaveAttribute('aria-activedescendant', options[1]?.id);
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(field()).toHaveAttribute('aria-activedescendant', options[0]?.id);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(field()).toHaveValue('#Pro ');
  });

  it('Q-06 critère 2 : après Échap, la tâche se crée normalement', async () => {
    await screen.findByRole('heading', { level: 1 });
    type('Appeler Paul #pe');
    await screen.findByRole('listbox');
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    submit();
    await waitFor(async () => expect((await created()).length).toBe(1));
  });

  it('Q-02 critère 9 : « Préparer la réunion de lundi » détecté, la croix rend le texte entier au titre', async () => {
    await screen.findByRole('heading', { level: 1 });
    type('Préparer la réunion de lundi');
    const group = await screen.findByRole('group', { name: 'Ce qui sera appliqué' });
    fireEvent.click(within(group).getAllByRole('button')[0] as HTMLElement);
    expect(screen.queryByRole('group', { name: 'Ce qui sera appliqué' })).toBeNull();
    submit();
    await waitFor(async () => expect((await created()).length).toBe(1));
    expect((await created())[0]).toMatchObject({ title: 'Préparer la réunion de lundi', time: null });
  });

  it('Q-02 critère 7 : « Lire Le Monde » et « Payer le 31 février » : aucune pastille', async () => {
    await screen.findByRole('heading', { level: 1 });
    for (const text of ['Lire Le Monde', 'Payer le 31 février']) {
      type(text);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByRole('group', { name: 'Ce qui sera appliqué' })).toBeNull();
    }
  });
});
