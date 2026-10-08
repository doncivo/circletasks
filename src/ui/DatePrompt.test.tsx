import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asLocalDate } from '../domain/types';
import { DatePrompt } from './DatePrompt';

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

// Mercredi 23 septembre 2026.
const props = {
  open: true,
  label: 'Choisir une date',
  confirmLabel: 'Valider',
  today: asLocalDate('2026-09-23'),
  initialValue: asLocalDate('2026-10-03'),
};

describe('DatePrompt (T-05, T-12, T-14)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('iPhone (Q-05) : la feuille est ouverte avec le focus dedans, et le piège ne déplace pas un focus déjà posé dans le formulaire', () => {
    mockViewport(440);
    render(<DatePrompt {...props} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Choisir une date' })).toContainElement(document.activeElement as HTMLElement);
  });

  it('PC : le champ est rempli avec la date proposée ; valider renvoie la date ; saisie libre comprise (critères 7, 10)', () => {
    mockViewport(1440);
    const onConfirm = vi.fn();
    render(<DatePrompt {...props} onConfirm={onConfirm} onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Date' });
    expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: '3 octobre, choisi' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
    expect(onConfirm).toHaveBeenLastCalledWith('2026-10-03', null);

    fireEvent.change(input, { target: { value: 'demain' } });
    expect(screen.getByText('jeudi 24 sept.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
    expect(onConfirm).toHaveBeenLastCalledWith('2026-09-24', null);
  });

  it('PC : Entrée valide, une saisie non comprise désactive Valider et Entrée (critère 8)', () => {
    mockViewport(1440);
    const onConfirm = vi.fn();
    render(<DatePrompt {...props} onConfirm={onConfirm} onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Date' });
    fireEvent.change(input, { target: { value: 'blabla' } });
    expect(screen.getByText('Date non comprise')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Valider' })).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '25/09' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledWith('2026-09-25', null);
  });

  it('PC : un clic sur un jour du calendrier le choisit, puis Valider (critère 9)', () => {
    mockViewport(1440);
    const onConfirm = vi.fn();
    render(<DatePrompt {...props} onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '15 octobre' }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
    expect(onConfirm).toHaveBeenCalledWith('2026-10-15', null);
  });

  it('« Un jour » (allowSomeday) : présélectionné si initialValue est null, valide (null, null) (T-12)', () => {
    mockViewport(1440);
    const onConfirm = vi.fn();
    render(<DatePrompt {...props} initialValue={null} allowSomeday onConfirm={onConfirm} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Un jour' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
    expect(onConfirm).toHaveBeenLastCalledWith(null, null);
    fireEvent.click(screen.getByRole('button', { name: 'Demain' }));
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
    expect(onConfirm).toHaveBeenLastCalledWith('2026-09-24', null);
  });

  it('sans allowSomeday : pas de puce « Un jour »', () => {
    mockViewport(1440);
    render(<DatePrompt {...props} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Un jour' })).not.toBeInTheDocument();
  });

  it('avec showTime : l’heure choisie est renvoyée', () => {
    mockViewport(1440);
    const onConfirm = vi.fn();
    render(<DatePrompt {...props} showTime onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Heure' }), { target: { value: '1030' } });
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
    expect(onConfirm).toHaveBeenCalledWith('2026-10-03', '10:30');
  });

  it('iPhone : puces et roues, valider renvoie la date de la roue', () => {
    mockViewport(390);
    const onConfirm = vi.fn();
    render(<DatePrompt {...props} onConfirm={onConfirm} onClose={vi.fn()} />);
    expect(screen.getByRole('spinbutton', { name: 'Jour' })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Heures' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Demain' }));
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
    expect(onConfirm).toHaveBeenCalledWith('2026-09-24', null);
  });

  it('Échap (PC) et Fermer (iPhone) n’appliquent rien', () => {
    mockViewport(1440);
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(<DatePrompt {...props} onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    mockViewport(440);
    render(<DatePrompt {...props} onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
