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

  it('appelle onBlur à la perte de focus (Note, T-03 critère 8)', () => {
    const onBlur = vi.fn();
    render(<TextField value="Détails" onChange={() => undefined} label="Note" multiline onBlur={onBlur} />);
    const field = screen.getByRole('textbox', { name: 'Note' });
    fireEvent.blur(field);
    expect(onBlur).toHaveBeenCalledOnce();
  });
});
