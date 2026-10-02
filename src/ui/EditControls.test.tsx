import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditModeSwitch, RemoveButton, SelectCircle, SelectionBar, SelectionBarButton } from './EditControls';

describe('commandes du mode édition (A-05)', () => {
  it('EditModeSwitch : aria-pressed reflète l’état, un clic le bascule', () => {
    const onChange = vi.fn();
    const { rerender } = render(<EditModeSwitch active={false} onChange={onChange} label="Mode édition" />);
    const button = screen.getByRole('button', { name: 'Mode édition' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<EditModeSwitch active onChange={onChange} label="Mode édition" />);
    expect(screen.getByRole('button', { name: 'Mode édition' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Mode édition' }));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('SelectCircle : état annoncé par aria-pressed, coche quand sélectionné', () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(<SelectCircle selected={false} onToggle={onToggle} label="Sélectionner : A" />);
    expect(container.querySelector('svg')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sélectionner : A' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<SelectCircle selected onToggle={onToggle} label="Désélectionner : A" />);
    expect(screen.getByRole('button', { name: 'Désélectionner : A' })).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('RemoveButton : libellé accessible avec le titre', () => {
    const onRemove = vi.fn();
    render(<RemoveButton onRemove={onRemove} label="Supprimer : A" />);
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer : A' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('SelectionBar : barre d’outils nommée, compteur annoncé, boutons d’action', () => {
    const onDelete = vi.fn();
    render(
      <SelectionBar label="Actions sur la sélection" countLabel="2 sélectionnées">
        <SelectionBarButton haspopup="menu" expanded={false} onClick={() => undefined}>
          {'Reporter'}
        </SelectionBarButton>
        <SelectionBarButton danger onClick={onDelete}>
          {'Supprimer'}
        </SelectionBarButton>
      </SelectionBar>,
    );
    const bar = screen.getByRole('toolbar', { name: 'Actions sur la sélection' });
    expect(bar).toHaveTextContent('2 sélectionnées');
    expect(screen.getByText('2 sélectionnées')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('button', { name: 'Reporter' })).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
