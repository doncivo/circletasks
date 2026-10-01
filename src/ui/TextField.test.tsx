import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TextField } from './TextField';

const PLACEHOLDER = 'Ajouter une tâche';

describe('TextField', () => {
  it('associe le libellé au champ (accessible même masqué)', () => {
    render(<TextField value="" onChange={() => undefined} label="Nouvelle tâche" placeholder={PLACEHOLDER} />);
    const input = screen.getByRole('textbox', { name: 'Nouvelle tâche' });
    expect(input).toHaveAttribute('placeholder', PLACEHOLDER);
  });

  it('appelle onChange avec la nouvelle valeur', () => {
    const onChange = vi.fn();
    render(<TextField value="" onChange={onChange} label="Nouvelle tâche" />);
    const input = screen.getByRole('textbox', { name: 'Nouvelle tâche' });
    fireEvent.change(input, { target: { value: 'Courses' } });
    expect(onChange).toHaveBeenCalledWith('Courses');
  });

  it('rend une zone de texte multiligne pour la note', () => {
    render(<TextField value="Détails" onChange={() => undefined} label="Note" multiline />);
    expect(screen.getByRole('textbox', { name: 'Note' }).tagName).toBe('TEXTAREA');
  });

  it('affiche le libellé visuellement si demandé', () => {
    render(<TextField value="" onChange={() => undefined} label="Note" visibleLabel />);
    const label = screen.getByText('Note');
    expect(label).not.toHaveClass('ct-visually-hidden');
  });
});
