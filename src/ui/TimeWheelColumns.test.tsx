import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalTime } from '../domain/types';
import { asLocalTime } from '../domain/types';
import { setFormatPrefs } from '../i18n/formatPrefs';
import { TimeWheelColumns } from './TimeWheelColumns';

function Harness({ initial, seen }: { initial: LocalTime | null; seen: (LocalTime | null)[] }) {
  const [value, setValue] = useState(initial);
  return (
    <TimeWheelColumns
      value={value}
      onChange={(next) => {
        seen.push(next);
        setValue(next);
      }}
    />
  );
}

const wheel = (name: string) => screen.getByRole('spinbutton', { name });

describe('Roues d’heure (P-03 critère 6)', () => {
  afterEach(() => {
    cleanup();
    setFormatPrefs({ timeFormat: '24h' });
  });

  it('24 h : heures 00 à 23, pas de colonne AM / PM', () => {
    const seen: (LocalTime | null)[] = [];
    render(<Harness initial={asLocalTime('15:30')} seen={seen} />);
    expect(screen.queryByRole('spinbutton', { name: 'Matin ou après-midi' })).toBeNull();
    fireEvent.keyDown(wheel('Heures'), { key: 'ArrowUp' });
    expect(seen).toEqual(['16:30']);
  });

  it('12 h : colonne AM / PM ; la valeur émise reste en 24 h', () => {
    setFormatPrefs({ timeFormat: '12h' });
    const seen: (LocalTime | null)[] = [];
    render(<Harness initial={asLocalTime('15:30')} seen={seen} />);
    expect(wheel('Matin ou après-midi')).toHaveAttribute('aria-valuetext', 'PM');
    fireEvent.keyDown(wheel('Heures'), { key: 'ArrowUp' });
    expect(seen.at(-1)).toBe('16:30');
    fireEvent.keyDown(wheel('Matin ou après-midi'), { key: 'ArrowDown' });
    expect(seen.at(-1)).toBe('04:30');
    expect(wheel('Matin ou après-midi')).toHaveAttribute('aria-valuetext', 'AM');
  });

  it('12 h : minuit s’affiche 12 et midi bascule sur PM', () => {
    setFormatPrefs({ timeFormat: '12h' });
    const seen: (LocalTime | null)[] = [];
    render(<Harness initial={asLocalTime('00:00')} seen={seen} />);
    expect(wheel('Heures')).toHaveAttribute('aria-valuenow', '1');
    fireEvent.keyDown(wheel('Matin ou après-midi'), { key: 'ArrowUp' });
    expect(seen.at(-1)).toBe('12:00');
  });

  it('sans heure, minutes et AM / PM sont grisées', () => {
    setFormatPrefs({ timeFormat: '12h' });
    render(<Harness initial={null} seen={[]} />);
    expect(wheel('Minutes')).toHaveAttribute('aria-disabled', 'true');
    expect(wheel('Matin ou après-midi')).toHaveAttribute('aria-disabled', 'true');
  });
});
