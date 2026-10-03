import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asLocalDate } from '../domain/types';
import { DatePicker } from './DatePicker';

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

const today = asLocalDate('2026-09-23');

describe('DatePicker (T-14, critère 13)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('iPhone : puces et roues', () => {
    mockViewport(440);
    const onChange = vi.fn();
    render(<DatePicker value={{ date: today, time: null }} today={today} onChange={onChange} />);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Demain' }));
    expect(onChange).toHaveBeenCalledWith({ date: '2026-09-24', time: null });
  });

  it('PC : champ « Date » à saisie libre', () => {
    mockViewport(1440);
    const onChange = vi.fn();
    render(<DatePicker value={null} today={today} onChange={onChange} />);
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    const field = screen.getByRole('combobox', { name: 'Date' });
    fireEvent.change(field, { target: { value: 'demain' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ date: '2026-09-24', time: null });
  });

  describe('« Un jour » indisponible (tâche récurrente, SD-03 critère 6, QB-11)', () => {
    const hint = 'Arrêtez d’abord la répétition';

    it('iPhone : la puce est grisée avec l’aide, sans effet au toucher', () => {
      mockViewport(440);
      const onChange = vi.fn();
      render(<DatePicker value={{ date: today, time: null }} today={today} onChange={onChange} somedayDisabledHint={hint} />);
      const chip = screen.getByRole('button', { name: 'Un jour' });
      expect(chip).toHaveAttribute('aria-disabled', 'true');
      expect(chip).toHaveAccessibleDescription(hint);
      fireEvent.click(chip);
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Demain' }));
      expect(onChange).toHaveBeenCalledWith({ date: '2026-09-24', time: null });
    });

    it('PC : la puce est grisée avec l’aide ; « un jour » saisi est refusé et Entrée ne valide pas', () => {
      mockViewport(1440);
      const onChange = vi.fn();
      render(<DatePicker value={{ date: today, time: null }} today={today} onChange={onChange} somedayDisabledHint={hint} />);
      const field = screen.getByRole('combobox', { name: 'Date' });
      fireEvent.click(field);
      const chip = screen.getByRole('button', { name: 'Un jour' });
      expect(chip).toHaveAttribute('aria-disabled', 'true');
      expect(chip).toHaveAccessibleDescription(hint);
      fireEvent.click(chip);
      expect(chip).toHaveAttribute('aria-pressed', 'false');
      fireEvent.change(field, { target: { value: 'un jour' } });
      expect(screen.getAllByText(hint).length).toBeGreaterThan(0);
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('sans l’aide, la puce « Un jour » reste active', () => {
      mockViewport(440);
      const onChange = vi.fn();
      render(<DatePicker value={{ date: today, time: null }} today={today} onChange={onChange} />);
      fireEvent.click(screen.getByRole('button', { name: 'Un jour' }));
      expect(onChange).toHaveBeenCalledWith({ date: null, time: null });
    });
  });
});
