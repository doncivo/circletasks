// Y-TECH-05 : bloc du compte rendu illisible (échec de chargement) : le message et « Réessayer » de la frontière des écrans à la demande,
// puis « Recharger » après un second échec ; jamais rien (aucun échec silencieux).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncDetailsCarryReportHost } from './SyncDetailsCarryReportHost';

afterEach(cleanup);

describe('chargement du bloc du compte rendu', () => {
  it('échec : message et « Réessayer » ; second échec : « Recharger »', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<SyncDetailsCarryReportHost load={() => Promise.reject(new Error('bloc illisible'))} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Impossible d’afficher cet écran.');
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByRole('button', { name: 'Recharger' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
  });
});
