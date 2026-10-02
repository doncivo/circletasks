import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { RecurrenceFields } from '../domain/model';
import { asLocalDate, type LocalDate } from '../domain/types';
import { RecurrencePicker } from './RecurrencePicker';

// Mercredi 23 sept. 2026.
const WED = asLocalDate('2026-09-23');

function Harness({ start = WED as LocalDate | null, onRule }: { start?: LocalDate | null; onRule?: (rule: RecurrenceFields | null) => void }) {
  const [rule, setRule] = useState<RecurrenceFields | null>(null);
  return (
    <RecurrencePicker
      value={rule}
      startDate={start}
      onChange={(next) => {
        setRule(next);
        onRule?.(next);
      }}
    />
  );
}

const radio = (name: string) => screen.getByRole('radio', { name });

describe('RecurrencePicker (T-09, Ajout.html)', () => {
  it('« Une fois » est le défaut', () => {
    render(<Harness />);
    expect(radio('Une fois')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Hebdo')).toHaveAttribute('aria-checked', 'false');
  });

  it('Hebdo propose le jour de la date (mercredi) et permet de cocher plusieurs jours (critère 1)', () => {
    const onRule = vi.fn();
    render(<Harness onRule={onRule} />);
    fireEvent.click(radio('Hebdo'));
    expect(screen.getByRole('button', { name: 'mercredi' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'lundi' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'lundi' }));
    expect(onRule).toHaveBeenLastCalledWith(expect.objectContaining({ freq: 'weekly', weekdays: [1, 3] }));
    // Le dernier jour coché ne peut pas être retiré.
    fireEvent.click(screen.getByRole('button', { name: 'lundi' }));
    fireEvent.click(screen.getByRole('button', { name: 'mercredi' }));
    expect(onRule).toHaveBeenLastCalledWith(expect.objectContaining({ weekdays: [3] }));
  });

  it('Mensuel : « le 23 » par défaut ; Autre permet « le 4ᵉ mercredi » et « le dernier mercredi » (critère 2)', () => {
    const onRule = vi.fn();
    render(<Harness onRule={onRule} />);
    fireEvent.click(radio('Mensuel'));
    expect(onRule).toHaveBeenLastCalledWith(expect.objectContaining({ freq: 'monthly', monthDay: 23, nthWeekday: null }));

    fireEvent.click(screen.getByRole('button', { name: /Autre : tous les N jours/ }));
    fireEvent.click(radio('Un jour de la semaine du mois'));
    expect(onRule).toHaveBeenLastCalledWith(expect.objectContaining({ monthDay: null, nthWeekday: { nth: 4, weekday: 3 } }));
    expect(screen.getByTestId('recurrence-summary')).toHaveTextContent('Mensuelle, le 4ᵉ mercredi');

    fireEvent.change(screen.getByLabelText('Rang dans le mois'), { target: { value: '-1' } });
    expect(onRule).toHaveBeenLastCalledWith(expect.objectContaining({ nthWeekday: { nth: -1, weekday: 3 } }));
    expect(screen.getByTestId('recurrence-summary')).toHaveTextContent('Mensuelle, le dernier mercredi');
  });

  it('Annuel : chaque 23 sept. (critère 3)', () => {
    const onRule = vi.fn();
    render(<Harness onRule={onRule} />);
    fireEvent.click(radio('Annuel'));
    expect(onRule).toHaveBeenLastCalledWith(expect.objectContaining({ freq: 'yearly', monthDay: 23 }));
    expect(radio('Annuel')).toHaveAttribute('aria-checked', 'true');
  });

  it('Autre : tous les N jours, N ≥ 2 seulement (critère 4)', () => {
    const onRule = vi.fn();
    render(<Harness onRule={onRule} />);
    fireEvent.click(screen.getByRole('button', { name: /Autre : tous les N jours/ }));
    fireEvent.click(radio('Tous les N jours'));
    expect(onRule).toHaveBeenLastCalledWith(expect.objectContaining({ freq: 'daily', interval: 2 }));
    const field = screen.getByLabelText('Nombre de jours');
    fireEvent.change(field, { target: { value: '3' } });
    expect(onRule).toHaveBeenLastCalledWith(expect.objectContaining({ freq: 'daily', interval: 3 }));
    expect(screen.getByTestId('recurrence-summary')).toHaveTextContent('Tous les 3 jours');
    onRule.mockClear();
    fireEvent.change(field, { target: { value: '1' } });
    expect(onRule).not.toHaveBeenCalled();
  });

  it('sans date de départ, la répétition est inactive (critère 5)', () => {
    render(<Harness start={null} />);
    expect(radio('Hebdo')).toBeDisabled();
    expect(radio('Mensuel')).toBeDisabled();
    expect(radio('Annuel')).toBeDisabled();
    expect(screen.getByText('Choisissez une date pour répéter la tâche.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Autre/ })).not.toBeInTheDocument();
  });

  it('changer la date de la tâche suit le jour par défaut, ou désactive la règle sans date', () => {
    const { rerender } = render(<RecurrencePickerProbe start={WED} />);
    fireEvent.click(radio('Mensuel'));
    rerender(<RecurrencePickerProbe start={asLocalDate('2026-09-25')} />);
    expect(screen.getByTestId('rule')).toHaveTextContent('"monthDay":25');
    rerender(<RecurrencePickerProbe start={null} />);
    expect(screen.getByTestId('rule')).toHaveTextContent('null');
  });
});

/** Variante qui garde la règle entre deux rendus avec une date de départ différente. */
function RecurrencePickerProbe({ start }: { start: LocalDate | null }) {
  const [rule, setRule] = useState<RecurrenceFields | null>(null);
  return (
    <>
      <RecurrencePicker value={rule} onChange={setRule} startDate={start} />
      <output data-testid="rule">{JSON.stringify(rule)}</output>
    </>
  );
}
