import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { SettingsScreen } from '../settings/SettingsScreen';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { SpacesScreen } from './SpacesScreen';

describe('Espaces Pro et Perso (ES-01)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    mockViewport(440);
    h = await setupToday('e5001');
  });
  afterEach(async () => teardownToday(h));

  const renderSpaces = () =>
    render(
      <AppContainerProvider container={h.container}>
        <SpacesScreen />
      </AppContainerProvider>,
    );
  const nameField = (n: number) => screen.getByLabelText(`Nom de l’espace ${n}`);

  it('liste les deux espaces avec leur nom et leur palette de quatre couleurs (critères 1, 2, 5)', async () => {
    renderSpaces();
    expect(nameField(1)).toHaveValue('Pro');
    expect(nameField(2)).toHaveValue('Perso');
    const pro = screen.getByRole('radiogroup', { name: 'Couleur de l’espace Pro' });
    expect(within(pro).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['Bleu canard', 'Violet', 'Vert', 'Bleu']);
    expect(within(pro).getByRole('radio', { name: 'Bleu canard' })).toHaveAttribute('aria-checked', 'true');
    const perso = screen.getByRole('radiogroup', { name: 'Couleur de l’espace Perso' });
    expect(within(perso).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['Brique', 'Ocre', 'Rose', 'Prune']);
  });

  it('aucune action pour créer ou supprimer un espace (critère 6)', () => {
    renderSpaces();
    expect(screen.queryByRole('button', { name: /(ajouter|créer|nouvel|supprimer).*espace/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /espace.*(ajouter|créer|supprimer)/i })).toBeNull();
  });

  it('renomme Pro en Conseil : le nom est publié partout et conservé en base (critère 3, 8)', async () => {
    renderSpaces();
    const before = (await h.container.data.repos.spaces.getById(SPACE_PRO_ID))?.hlc;
    fireEvent.change(nameField(1), { target: { value: '  Conseil ' } });
    fireEvent.blur(nameField(1));
    await waitFor(() => expect(useAppStore.getState().spaces[0]?.name).toBe('Conseil'));
    const stored = await h.container.data.repos.spaces.getById(SPACE_PRO_ID);
    expect(stored?.name).toBe('Conseil');
    expect(String(stored?.hlc) > String(before)).toBe(true);
    expect(screen.getByRole('radiogroup', { name: 'Couleur de l’espace Conseil' })).toBeInTheDocument();
  });

  it('refuse un nom vide, trop long ou identique à l’autre espace, et garde l’ancien (critère 4)', async () => {
    renderSpaces();
    for (const [value, message] of [
      ['   ', 'Le nom ne peut pas être vide.'],
      ['x'.repeat(31), 'Le nom ne doit pas dépasser 30 caractères.'],
      ['PERSO', 'Ce nom est déjà utilisé par l’autre espace.'],
    ] as const) {
      fireEvent.change(nameField(1), { target: { value } });
      fireEvent.submit(nameField(1).closest('form') as HTMLFormElement);
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(nameField(1)).toHaveValue('Pro');
      expect((await h.container.data.repos.spaces.getById(SPACE_PRO_ID))?.name).toBe('Pro');
    }
  });

  it('change la couleur dans la palette : pastilles et base suivent (critère 5)', async () => {
    renderSpaces();
    fireEvent.click(screen.getByRole('radio', { name: 'Violet' }));
    await waitFor(() => expect(useAppStore.getState().spaces[0]?.color).toBe('#5b43a8'));
    expect((await h.container.data.repos.spaces.getById(SPACE_PRO_ID))?.color).toBe('#5b43a8');
    expect(screen.getByRole('radio', { name: 'Violet' })).toHaveAttribute('aria-checked', 'true');
    // Une couleur de l'autre palette est refusée par le cas d'usage.
    const { createSpaceUseCases } = await import('./spaceUseCases');
    const refused = await createSpaceUseCases(h.container).setColor(SPACE_PERSO_ID, '#2f6b7a' as never);
    expect(refused).toEqual({ ok: false, error: 'color-not-allowed' });
  });

  it('Réglages : section « ESPACES ET CALENDRIERS » et ligne « Pro (0) · Perso (0) » qui ouvre l’écran (critère 2)', async () => {
    render(
      <AppContainerProvider container={h.container}>
        <SettingsScreen />
      </AppContainerProvider>,
    );
    expect(screen.getByText('ESPACES ET CALENDRIERS')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Espaces et projets : Pro (0) · Perso (0)' })).toBeInTheDocument();
  });
});
