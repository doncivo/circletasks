import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DateChoice } from '../domain/dateInput';
import { asLocalDate } from '../domain/types';
import { t } from '../i18n';
import { setFormatPrefs } from '../i18n/formatPrefs';
import { DateField } from './DateField';

// Mercredi 23 septembre 2026 (PC-Date.html).
const TODAY = asLocalDate('2026-09-23');

function Harness({ initial = null, onChange, onSubmit }: { initial?: DateChoice | null; onChange?: (c: DateChoice | null) => void; onSubmit?: () => void }) {
  const [value, setValue] = useState<DateChoice | null>(initial);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <DateField
        value={value}
        today={TODAY}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
      <input aria-label={t('tasks.titleLabel')} />
    </form>
  );
}

const field = () => screen.getByRole('combobox', { name: 'Date' });
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
const dialog = () => screen.getByRole('dialog', { name: 'Choisir une date' });

describe('DateField (T-14, PC)', () => {
  afterEach(cleanup);

  it('saisie libre : le bandeau « Compris : » affiche l’interprétation en direct (critère 7)', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    type('ven 10h');
    expect(dialog()).toHaveTextContent('Compris : vendredi 25 sept. à 10:00');
    type('demain');
    expect(dialog()).toHaveTextContent('Compris : jeudi 24 sept.');
    type('lun. 10h');
    expect(dialog()).toHaveTextContent('Compris : lundi 28 sept. à 10:00');
    type('25/09');
    expect(dialog()).toHaveTextContent('Compris : vendredi 25 sept.');
    type('25 sept. 14:30');
    expect(dialog()).toHaveTextContent('Compris : vendredi 25 sept. à 14:30');
    type('dans 3 jours');
    expect(dialog()).toHaveTextContent('Compris : samedi 26 sept.');
  });

  it('Entrée valide la saisie, ferme la fenêtre, et ne soumet pas le formulaire (critère 7)', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness onChange={onChange} onSubmit={onSubmit} />);
    type('ven 10h');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ date: '2026-09-25', time: '10:00' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(field()).toHaveValue('ven. 25 sept. 10:00');
  });

  it('Échap ferme sans rien changer et rétablit le champ (critère 7)', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ date: TODAY, time: null }} onChange={onChange} />);
    expect(field()).toHaveValue('Aujourd’hui');
    type('ven 10h');
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(field()).toHaveValue('Aujourd’hui');
  });

  it('saisie non comprise : « Date non comprise », Entrée ne valide pas (critère 8)', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    type('blabla');
    expect(dialog()).toHaveTextContent('Date non comprise');
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('un clic sur un jour du mini-calendrier devient la date choisie (critère 9)', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(field());
    fireEvent.click(within(dialog()).getByRole('button', { name: '25 septembre' }));
    expect(onChange).toHaveBeenCalledWith({ date: '2026-09-25', time: null });
    expect(field()).toHaveValue('ven. 25 sept.');
  });

  it('jour courant et jour choisi sont repérés dans le calendrier ; lundi en premier, sept. 2026 (critères 9, 12)', () => {
    render(<Harness initial={{ date: asLocalDate('2026-09-25'), time: null }} />);
    fireEvent.click(field());
    const grid = within(dialog());
    expect(grid.getByText('Septembre 2026')).toBeInTheDocument();
    expect(grid.getByRole('button', { name: '23 septembre, aujourd’hui' })).toHaveAttribute('data-today', 'true');
    expect(grid.getByRole('gridcell', { selected: true })).toContainElement(grid.getByRole('button', { name: '25 septembre, choisi' }));
    expect(grid.getByRole('grid')).toBeInTheDocument();
    expect(grid.getAllByRole('row')).toHaveLength(6);
    expect(grid.getAllByRole('columnheader')).toHaveLength(7);
    const initials = Array.from(dialog().querySelectorAll('.ct-date-editor__weekday')).map((n) => n.textContent);
    expect(initials).toEqual(['L', 'M', 'M', 'J', 'V', 'S', 'D']);
  });

  it('« Mois précédent » et « Mois suivant » changent de mois (critère 9)', () => {
    render(<Harness />);
    fireEvent.click(field());
    fireEvent.click(screen.getByRole('button', { name: 'Mois suivant' }));
    expect(screen.getByText('Octobre 2026')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mois précédent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mois précédent' }));
    expect(screen.getByText('Août 2026')).toBeInTheDocument();
  });

  it('navigation clavier par flèches dans la grille, avec changement de mois (critère 9)', () => {
    render(<Harness />);
    fireEvent.click(field());
    const today = screen.getByRole('button', { name: '23 septembre, aujourd’hui' });
    expect(today).toHaveAttribute('tabindex', '0');
    today.focus();
    fireEvent.keyDown(today, { key: 'ArrowRight' });
    expect(screen.getByRole('button', { name: '24 septembre' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('button', { name: '24 septembre' }), { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: '1 octobre' })).toHaveFocus();
    expect(screen.getByText('Octobre 2026')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: '1 octobre' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('button', { name: '30 septembre' })).toHaveFocus();
  });

  it('puces « Aujourd’hui », « Demain », « Lundi prochain », « Un jour » (critère 10)', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const choose = (name: string) => {
      fireEvent.click(field());
      fireEvent.click(within(dialog()).getByRole('button', { name }));
    };
    choose('Aujourd’hui');
    expect(onChange).toHaveBeenLastCalledWith({ date: '2026-09-23', time: null });
    choose('Demain');
    expect(onChange).toHaveBeenLastCalledWith({ date: '2026-09-24', time: null });
    choose('Lundi prochain');
    expect(onChange).toHaveBeenLastCalledWith({ date: '2026-09-28', time: null });
    choose('Un jour');
    expect(onChange).toHaveBeenLastCalledWith({ date: null, time: null });
    expect(field()).toHaveValue('Un jour');
  });

  it('une puce de date garde l’heure choisie ; « Un jour » la retire', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ date: TODAY, time: '10:00' as never }} onChange={onChange} />);
    fireEvent.click(field());
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Demain' }));
    expect(onChange).toHaveBeenLastCalledWith({ date: '2026-09-24', time: '10:00' });
  });

  it('champ « Heure » : « 10 », « 10h », « 10:00 », « 1030 » ; vide = sans heure (critère 11)', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ date: asLocalDate('2026-09-25'), time: null }} onChange={onChange} />);
    fireEvent.click(field());
    const time = within(dialog()).getByRole('textbox', { name: 'Heure' });
    for (const [input, expected] of [
      ['10', '10:00'],
      ['10h', '10:00'],
      ['10:00', '10:00'],
      ['1030', '10:30'],
    ] as const) {
      fireEvent.change(time, { target: { value: input } });
      expect(dialog()).toHaveTextContent(`Compris : vendredi 25 sept. à ${expected}`);
    }
    fireEvent.keyDown(time, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({ date: '2026-09-25', time: '10:30' });

    fireEvent.click(field());
    fireEvent.change(within(dialog()).getByRole('textbox', { name: 'Heure' }), { target: { value: '' } });
    fireEvent.keyDown(within(dialog()).getByRole('textbox', { name: 'Heure' }), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({ date: '2026-09-25', time: null });
  });

  it('heure non comprise : message, Entrée ne valide pas', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ date: asLocalDate('2026-09-25'), time: null }} onChange={onChange} />);
    fireEvent.click(field());
    const time = within(dialog()).getByRole('textbox', { name: 'Heure' });
    fireEvent.change(time, { target: { value: '25h' } });
    expect(dialog()).toHaveTextContent('Heure non comprise');
    fireEvent.keyDown(time, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('une heure saisie sans date vaut aujourd’hui à cette heure', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(field());
    fireEvent.change(within(dialog()).getByRole('textbox', { name: 'Heure' }), { target: { value: '14h' } });
    fireEvent.keyDown(within(dialog()).getByRole('textbox', { name: 'Heure' }), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({ date: TODAY, time: '14:00' });
  });

  it('« Un jour » désactive le champ « Heure »', () => {
    render(<Harness initial={{ date: null, time: null }} />);
    fireEvent.click(field());
    expect(within(dialog()).getByRole('textbox', { name: 'Heure' })).toBeDisabled();
  });

  it('perdre le focus avec une saisie comprise la valide ; non comprise, le champ revient à sa valeur', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ date: TODAY, time: null }} onChange={onChange} />);
    type('demain');
    fireEvent.blur(field(), { relatedTarget: screen.getByLabelText(t('tasks.titleLabel')) });
    expect(onChange).toHaveBeenLastCalledWith({ date: '2026-09-24', time: null });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    onChange.mockClear();
    type('n’importe quoi');
    fireEvent.blur(field(), { relatedTarget: screen.getByLabelText(t('tasks.titleLabel')) });
    expect(onChange).not.toHaveBeenCalled();
    expect(field()).toHaveValue('Demain');
  });

  it('champ vidé puis validé : retour au jour affiché (null)', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ date: TODAY, time: null }} onChange={onChange} />);
    type('');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('une date passée ou d’une autre année se relit correctement (aller-retour du texte du champ)', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ date: asLocalDate('2030-03-04'), time: null }} onChange={onChange} />);
    expect(field()).toHaveValue('4 mars 2030');
    type('4 mars 2030');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalledWith(null);
    expect(dialogOrNull()).toBeNull();
  });

  it('s’ouvre à la flèche bas et par le bouton calendrier', () => {
    render(<Harness />);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(dialog()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir le calendrier' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir le calendrier' }));
    expect(dialog()).toBeInTheDocument();
  });
});

function dialogOrNull(): HTMLElement | null {
  return screen.queryByRole('dialog', { name: 'Choisir une date' });
}

describe('DateField : format 12 h (P-03 critère 6)', () => {
  afterEach(() => {
    cleanup();
    setFormatPrefs({ timeFormat: '24h' });
  });

  it('« ven 3:30 pm » et « ven 15h30 » sont compris dans les deux formats, affichés selon le réglage', () => {
    setFormatPrefs({ timeFormat: '12h' });
    render(<Harness />);
    type('ven 3:30 pm');
    expect(dialog()).toHaveTextContent('Compris : vendredi 25 sept. à 3:30 PM');
    type('ven 15h30');
    expect(dialog()).toHaveTextContent('Compris : vendredi 25 sept. à 3:30 PM');
    type('ven 12 am');
    expect(dialog()).toHaveTextContent('Compris : vendredi 25 sept. à 12:00 AM');
    type('ven 12:00 pm');
    expect(dialog()).toHaveTextContent('Compris : vendredi 25 sept. à 12:00 PM');
  });

  it('24 h : « ven 3:30 pm » s’affiche « 15:30 »', () => {
    render(<Harness />);
    type('ven 3:30 pm');
    expect(dialog()).toHaveTextContent('Compris : vendredi 25 sept. à 15:30');
  });
});
