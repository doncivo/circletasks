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

const props = { open: true, label: 'Choisir une date', confirmLabel: 'Valider', initialValue: asLocalDate('2026-10-03') };

describe('DatePrompt', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('valide la date saisie ; une valeur vide désactive Valider', () => {
    mockViewport(1440);
    const onConfirm = vi.fn();
    render(<DatePrompt {...props} onConfirm={onConfirm} onClose={vi.fn()} />);
    const input = screen.getByLabelText('Choisir une date de report');
    expect(input).toHaveValue('2026-10-03');
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Valider' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '2026-11-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
    expect(onConfirm).toHaveBeenCalledWith('2026-11-01');
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
