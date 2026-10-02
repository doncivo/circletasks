import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DragHandle } from './DragHandle';
import { useSortable } from './useSortable';

const IDS = ['a', 'b', 'c', 'd'];
const ROW_HEIGHT = 50;

function List({ onMove, movable = () => true, handles = false, disabled = false }: { onMove: (id: string, to: number) => void; movable?: (id: string) => boolean; handles?: boolean; disabled?: boolean }) {
  const sortable = useSortable({ ids: IDS, onMove, isMovable: movable, disabled });
  return (
    <div {...sortable.containerProps}>
      {IDS.map((id) => (
        <div key={id} data-testid={id} {...sortable.itemProps(id)} {...(handles ? {} : sortable.dragProps(id, 'row'))}>
          <button type="button" onClick={() => document.body.setAttribute('data-clicked', id)}>
            {id}
          </button>
          <input aria-label={`champ ${id}`} />
          {handles && <DragHandle label={`Déplacer : ${id}`} {...sortable.dragProps(id, 'handle')} />}
        </div>
      ))}
      <output data-testid="drag">{sortable.drag ? `${sortable.drag.id}->${String(sortable.drag.toIndex)}:${sortable.drag.mode}` : ''}</output>
    </div>
  );
}

/** Événement de pointeur natif (jsdom n'a pas PointerEvent) avec type de pointeur et identifiant. */
function pointer(target: EventTarget, type: string, clientY: number, pointerType: 'mouse' | 'touch' = 'mouse', button = 0): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY, button });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

describe('useSortable (A-02)', () => {
  beforeEach(() => {
    // Lignes de 50 px empilées : centre de la ligne i = 25 + 50 i.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = IDS.indexOf(this.dataset['sortableId'] ?? '');
      const top = index * ROW_HEIGHT;
      return { top, bottom: top + ROW_HEIGHT, left: 0, right: 100, width: 100, height: ROW_HEIGHT, x: 0, y: top, toJSON: () => ({}) };
    });
  });
  afterEach(async () => {
    // Laisse expirer l'écouteur « clic ignoré » posé après chaque glisser (retiré au tour suivant).
    await new Promise((resolve) => setTimeout(resolve, 5));
    cleanup();
    vi.restoreAllMocks();
    document.body.removeAttribute('data-clicked');
  });

  it('souris : glisser une ligne au-delà de la suivante la dépose à sa nouvelle position (critère 2)', () => {
    const onMove = vi.fn();
    render(<List onMove={onMove} />);
    pointer(screen.getByTestId('a'), 'pointerdown', 25);
    pointer(window, 'pointermove', 80); // centre 105 : après b (75), avant c (125)
    expect(screen.getByTestId('drag')).toHaveTextContent('a->1:mouse');
    pointer(window, 'pointerup', 80);
    expect(onMove).toHaveBeenCalledWith('a', 1);
  });

  it('souris : indicateur d’insertion avant la ligne qui prend la suite, ou après la dernière', () => {
    render(<List onMove={vi.fn()} />);
    pointer(screen.getByTestId('d'), 'pointerdown', 175);
    pointer(window, 'pointermove', 100); // centre 100 : après b (75), avant c
    expect(screen.getByTestId('c')).toHaveAttribute('data-drop', 'before');
    expect(screen.getByTestId('d')).toHaveAttribute('data-dragging', 'true');
    pointer(window, 'pointermove', 260);
    expect(screen.getByTestId('c')).toHaveAttribute('data-drop', 'after');
    pointer(window, 'pointerup', 260);
  });

  it('un déplacement vers le haut vise une position plus haute', () => {
    const onMove = vi.fn();
    render(<List onMove={onMove} />);
    pointer(screen.getByTestId('c'), 'pointerdown', 125);
    pointer(window, 'pointermove', 40); // centre 40 : avant b (75), après a (25)
    pointer(window, 'pointerup', 40);
    expect(onMove).toHaveBeenCalledWith('c', 1);
  });

  it('un clic sans déplacement n’est pas un glisser et reste un clic (critère 2)', () => {
    const onMove = vi.fn();
    render(<List onMove={onMove} />);
    pointer(screen.getByRole('button', { name: 'b' }), 'pointerdown', 75);
    pointer(window, 'pointermove', 77);
    pointer(window, 'pointerup', 77);
    fireEvent.click(screen.getByRole('button', { name: 'b' }));
    expect(onMove).not.toHaveBeenCalled();
    expect(document.body).toHaveAttribute('data-clicked', 'b');
  });

  it('le clic qui suit un glisser est ignoré (la fiche ne s’ouvre pas en lâchant)', () => {
    render(<List onMove={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'a' });
    pointer(button, 'pointerdown', 25);
    pointer(window, 'pointermove', 120);
    pointer(window, 'pointerup', 120);
    fireEvent.click(button);
    expect(document.body).not.toHaveAttribute('data-clicked');
  });

  it('ne démarre pas depuis un champ de saisie ni avec un autre bouton que le principal', () => {
    const onMove = vi.fn();
    render(<List onMove={onMove} />);
    pointer(screen.getByLabelText('champ a'), 'pointerdown', 25);
    pointer(window, 'pointermove', 120);
    pointer(window, 'pointerup', 120);
    pointer(screen.getByTestId('a'), 'pointerdown', 25, 'mouse', 2);
    pointer(window, 'pointermove', 120);
    pointer(window, 'pointerup', 120);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('une ligne non déplaçable (routine, terminée) ne se saisit pas (critères 6, 7)', () => {
    const onMove = vi.fn();
    render(<List onMove={onMove} movable={(id) => id !== 'a'} />);
    pointer(screen.getByTestId('a'), 'pointerdown', 25);
    pointer(window, 'pointermove', 120);
    pointer(window, 'pointerup', 120);
    expect(onMove).not.toHaveBeenCalled();
    expect(screen.getByTestId('drag')).toHaveTextContent('');
  });

  it('désactivé : aucun glisser', () => {
    const onMove = vi.fn();
    render(<List onMove={onMove} disabled />);
    pointer(screen.getByTestId('a'), 'pointerdown', 25);
    pointer(window, 'pointermove', 120);
    pointer(window, 'pointerup', 120);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('tactile : seule la poignée saisit, et les autres lignes s’écartent (critère 1)', () => {
    const onMove = vi.fn();
    render(<List onMove={onMove} handles />);
    // Toucher la ligne ne fait rien (le défilement reste libre).
    pointer(screen.getByTestId('b'), 'pointerdown', 75, 'touch');
    pointer(window, 'pointermove', 200, 'touch');
    pointer(window, 'pointerup', 200, 'touch');
    expect(onMove).not.toHaveBeenCalled();

    pointer(screen.getByRole('button', { name: 'Déplacer : a' }), 'pointerdown', 25, 'touch');
    pointer(window, 'pointermove', 130, 'touch'); // centre 130 : après c (125)
    expect(screen.getByTestId('drag')).toHaveTextContent('a->2:touch');
    expect(screen.getByTestId('b')).toHaveStyle({ transform: 'translateY(-50px)' });
    expect(screen.getByTestId('c')).toHaveStyle({ transform: 'translateY(-50px)' });
    expect(screen.getByTestId('d').style.transform).toBe('');
    pointer(window, 'pointerup', 130, 'touch');
    expect(onMove).toHaveBeenCalledWith('a', 2);
  });

  it('tactile vers le haut : les lignes dépassées descendent', () => {
    render(<List onMove={vi.fn()} handles />);
    pointer(screen.getByRole('button', { name: 'Déplacer : d' }), 'pointerdown', 175, 'touch');
    pointer(window, 'pointermove', 60, 'touch');
    expect(screen.getByTestId('drag')).toHaveTextContent('d->1:touch');
    expect(screen.getByTestId('b')).toHaveStyle({ transform: 'translateY(50px)' });
    expect(screen.getByTestId('c')).toHaveStyle({ transform: 'translateY(50px)' });
    pointer(window, 'pointerup', 60, 'touch');
  });

  it('Échap abandonne le glisser sans rien déplacer', () => {
    const onMove = vi.fn();
    render(<List onMove={onMove} />);
    pointer(screen.getByTestId('a'), 'pointerdown', 25);
    pointer(window, 'pointermove', 120);
    expect(screen.getByTestId('drag')).not.toHaveTextContent('');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('drag')).toHaveTextContent('');
    pointer(window, 'pointerup', 120);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('l’annulation du pointeur abandonne le glisser', () => {
    const onMove = vi.fn();
    render(<List onMove={onMove} />);
    pointer(screen.getByTestId('a'), 'pointerdown', 25);
    pointer(window, 'pointermove', 120);
    pointer(window, 'pointercancel', 120);
    expect(screen.getByTestId('drag')).toHaveTextContent('');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('relâcher à la position de départ ne déplace rien', () => {
    const onMove = vi.fn();
    render(<List onMove={onMove} />);
    pointer(screen.getByTestId('b'), 'pointerdown', 75);
    pointer(window, 'pointermove', 120);
    pointer(window, 'pointermove', 78);
    pointer(window, 'pointerup', 78);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('la poignée : ↑ et ↓ déplacent d’une position, libellé accessible', () => {
    const up = vi.fn();
    const down = vi.fn();
    render(<DragHandle label="Déplacer : x" onPointerDown={() => undefined} onMoveUp={up} onMoveDown={down} />);
    const handle = screen.getByRole('button', { name: 'Déplacer : x' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(up).toHaveBeenCalledTimes(1);
    expect(down).toHaveBeenCalledTimes(1);
  });
});
