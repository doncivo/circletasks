import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DateChoice } from '../domain/dateInput';
import { asLocalDate, asLocalTime } from '../domain/types';
import { DateWheels } from './DateWheels';

// Mercredi 23 septembre 2026 (Ajout.html : « Mar. 22 sept. », « Aujourd'hui », « Jeu. 24 sept. »).
const TODAY = asLocalDate('2026-09-23');

function Harness({ initial, onChange }: { initial: DateChoice; onChange?: (c: DateChoice) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <DateWheels
      value={value}
      today={TODAY}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const wheel = (name: string) => screen.getByRole('spinbutton', { name });

describe('DateWheels (T-14, iPhone)', () => {
  afterEach(cleanup);

  it('jour centré sur « Aujourd’hui », puce « Aujourd’hui » active, jours voisins au format « Jeu. 24 sept. » (critères 1, 2)', () => {
    render(<Harness initial={{ date: TODAY, time: null }} />);
    expect(wheel('Jour')).toHaveAttribute('aria-valuetext', 'Aujourd’hui');
    expect(screen.getByRole('button', { name: 'Aujourd’hui' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Demain' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Jeu. 24 sept.')).toBeInTheDocument();
    expect(screen.getByText('Mar. 22 sept.')).toBeInTheDocument();
  });

  it('faire défiler les jours met la puce à jour : « Demain » si demain, aucune sinon (critère 2)', () => {
    render(<Harness initial={{ date: TODAY, time: null }} />);
    fireEvent.keyDown(wheel('Jour'), { key: 'ArrowUp' });
    expect(wheel('Jour')).toHaveAttribute('aria-valuetext', 'Jeu. 24 sept.');
    expect(screen.getByRole('button', { name: 'Demain' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(wheel('Jour'), { key: 'ArrowUp' });
    for (const name of ['Aujourd’hui', 'Demain', 'Un jour']) expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(wheel('Jour'), { key: 'ArrowDown' });
    fireEvent.keyDown(wheel('Jour'), { key: 'ArrowDown' });
    fireEvent.keyDown(wheel('Jour'), { key: 'ArrowDown' });
    expect(wheel('Jour')).toHaveAttribute('aria-valuetext', 'Mar. 22 sept.'); // jours passés proposés
  });

  it('minutes par pas de 5 ; heures « — » puis 00 à 23 (critère 3)', () => {
    render(<Harness initial={{ date: TODAY, time: asLocalTime('10:00') }} />);
    expect(wheel('Heures')).toHaveAttribute('aria-valuemax', '24');
    expect(wheel('Minutes')).toHaveAttribute('aria-valuemax', '11');
    fireEvent.keyDown(wheel('Minutes'), { key: 'ArrowUp' });
    expect(wheel('Minutes')).toHaveAttribute('aria-valuetext', '5 minutes');
    fireEvent.keyDown(wheel('Minutes'), { key: 'End' });
    expect(wheel('Minutes')).toHaveAttribute('aria-valuetext', '55 minutes');
    fireEvent.keyDown(wheel('Heures'), { key: 'End' });
    expect(wheel('Heures')).toHaveAttribute('aria-valuetext', '23 heures');
    fireEvent.keyDown(wheel('Heures'), { key: 'Home' });
    fireEvent.keyDown(wheel('Heures'), { key: 'ArrowUp' });
    expect(wheel('Heures')).toHaveAttribute('aria-valuetext', '0 heure');
  });

  it('nouvelle tâche : heures sur « — », minutes grisées ; choisir 10 les active ; revenir sur « — » enregistre sans heure (critère 4, Q9)', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ date: TODAY, time: null }} onChange={onChange} />);
    expect(wheel('Heures')).toHaveAttribute('aria-valuetext', 'Sans heure');
    expect(wheel('Minutes')).toHaveAttribute('aria-disabled', 'true');

    for (let i = 0; i < 11; i += 1) fireEvent.keyDown(wheel('Heures'), { key: 'ArrowUp' });
    expect(wheel('Heures')).toHaveAttribute('aria-valuetext', '10 heures');
    expect(wheel('Minutes')).not.toHaveAttribute('aria-disabled');
    expect(onChange).toHaveBeenLastCalledWith({ date: TODAY, time: '10:00' });

    fireEvent.keyDown(wheel('Minutes'), { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith({ date: TODAY, time: '10:05' });

    fireEvent.keyDown(wheel('Heures'), { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith({ date: TODAY, time: null });
    expect(wheel('Minutes')).toHaveAttribute('aria-disabled', 'true');
    // Les trois roues restent affichées (pas d'interrupteur « Heure »).
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getAllByRole('spinbutton')).toHaveLength(3);
  });

  it('les minutes d’une heure existante sont arrondies au pas de 5', () => {
    render(<Harness initial={{ date: TODAY, time: asLocalTime('10:07') }} />);
    expect(wheel('Minutes')).toHaveAttribute('aria-valuetext', '5 minutes');
  });

  it('« Demain » place la roue sur demain et garde l’heure (critère 5)', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ date: TODAY, time: asLocalTime('09:30') }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Demain' }));
    expect(onChange).toHaveBeenLastCalledWith({ date: '2026-09-24', time: '09:30' });
    expect(wheel('Jour')).toHaveAttribute('aria-valuetext', 'Jeu. 24 sept.');
  });

  it('« Un jour » grise les trois roues et retire date et heure ; une puce de date les réactive (critère 5)', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ date: TODAY, time: asLocalTime('09:30') }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Un jour' }));
    expect(onChange).toHaveBeenLastCalledWith({ date: null, time: null });
    for (const name of ['Jour', 'Heures', 'Minutes']) expect(wheel(name)).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Un jour' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Sans date : la tâche ira dans « Un jour ».')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Aujourd’hui' }));
    expect(onChange).toHaveBeenLastCalledWith({ date: TODAY, time: null });
    expect(wheel('Jour')).not.toHaveAttribute('aria-disabled');
  });

  it('showTime=false : seule la roue des jours ; allowSomeday=false : pas de puce « Un jour »', () => {
    render(<DateWheels value={{ date: TODAY, time: null }} today={TODAY} onChange={() => undefined} showTime={false} allowSomeday={false} />);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Un jour' })).not.toBeInTheDocument();
  });
});
