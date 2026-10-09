import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoveryCodeOf, RecoveryFailure } from './RecoveryFailure';

/** P-04-iOS, revue I1 : écran « Restauration interrompue » : une action utile par cause, jamais un « Réessayer » vain. */
describe('RecoveryFailure', () => {
  afterEach(() => cleanup());

  it('recovery-conflict : « Mettre les fichiers en conflit de côté », puis rechargement si la récupération aboutit', async () => {
    const reload = vi.fn();
    const setAside = vi.fn(() => Promise.resolve({ state: 'ready' as const }));
    render(<RecoveryFailure message="startup-recovery: recovery-conflict" setAside={setAside} reload={reload} />);
    expect(screen.getByText(/rien n’est supprimé/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mettre les fichiers en conflit de côté' }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
  });

  it('unsafe-restore-file encore impossible : consigne de rouvrir avec le code, plus de bouton', async () => {
    const reload = vi.fn();
    render(<RecoveryFailure message="startup-recovery: unsafe-restore-file" setAside={() => Promise.resolve({ state: 'failed', code: 'io' })} reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mettre les fichiers en conflit de côté' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('fermez puis rouvrez CircleTasks');
    expect(screen.getByRole('alert')).toHaveTextContent('Code : io');
    expect(screen.queryByRole('button')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('ancienne base mise de côté et base neuve : renvoi vers « Avant restauration », rechargement seulement sur « Continuer »', async () => {
    const reload = vi.fn();
    render(<RecoveryFailure message="startup-recovery: unsafe-restore-file" setAside={() => Promise.resolve({ state: 'ready' as const, notice: 'fresh-base' as const })} reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mettre les fichiers en conflit de côté' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Avant restauration');
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continuer' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('no-data-dir et sql-plugin : texte propre, aucune action vaine', () => {
    render(<RecoveryFailure message="startup-recovery: no-data-dir" />);
    expect(screen.getByText(/dossier des données de l’app est introuvable/)).toBeInTheDocument();
    cleanup();
    render(<RecoveryFailure message="startup-recovery: sql-plugin" />);
    expect(screen.getByText(/module de base de données n’a pas démarré/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(recoveryCodeOf('autre')).toBe('unknown');
  });
});
