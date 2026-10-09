import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MoveRight, X } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Icon } from './Icon';
import { SwipeRow, SwipeRowGroup, SWIPE_ROW_RULES, type RowGestureFeedback, type SwipeRowAction, type SwipeRowProps } from './SwipeRow';

/** A-07 critères 1 à 3, 8 à 12, 14 (règle de geste) et 16 à 18 : composant SwipeRow, événements de pointeur tactile. */

const BASE = 1000;
const CONTENT = 'contenu';
const TITLE = 'Courses';
const FIELD = 'champ';

function touch(target: Element, type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', x: number, y: number, at: number, pointerType = 'touch'): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: pointerType }, timeStamp: { value: BASE + at } });
  fireEvent(target, event);
}

function makeFeedback() {
  const calls: string[] = [];
  const feedback: RowGestureFeedback = {
    threshold: () => calls.push('threshold'),
    open: () => calls.push('open'),
    commit: () => calls.push('commit'),
    succeeded: () => calls.push('succeeded'),
    longPress: () => calls.push('longPress'),
  };
  return { calls, feedback };
}

function actions(onSelect: (id: string) => void): SwipeRowAction[] {
  return [
    { id: 'postpone', label: 'Reporter', icon: <Icon icon={MoveRight} size={20} />, tone: 'soft', onSelect: () => onSelect('postpone') },
    { id: 'delete', label: 'Supprimer', icon: <Icon icon={X} size={20} />, tone: 'danger', onSelect: () => onSelect('delete') },
  ];
}

function sized(row: HTMLElement): void {
  row.getBoundingClientRect = () => ({ width: 400, height: 66, top: 0, left: 0, right: 400, bottom: 66, x: 0, y: 0, toJSON: () => ({}) });
}

function setup(props: Partial<SwipeRowProps> = {}) {
  const { calls, feedback } = makeFeedback();
  const onCommit = vi.fn(() => Promise.resolve(true));
  const onSelect = vi.fn();
  const onLongPress = vi.fn();
  render(
    <SwipeRow rowId="a" title={TITLE} right={{ label: 'Terminer', tone: 'complete', onCommit }} left={actions(onSelect)} onLongPress={onLongPress} disabled={false} feedback={feedback} {...props}>
      <p>{CONTENT}</p>
      <input aria-label={FIELD} />
    </SwipeRow>,
  );
  const row = document.querySelector<HTMLElement>('.ct-swipe-row') as HTMLElement;
  sized(row);
  return { row, calls, onCommit, onSelect, onLongPress };
}

afterEach(() => {
  // Les minuteries du clic avalé (`swallowClickAfterDrag`) sont vidées : aucun écouteur ne survit au test suivant.
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  window.dispatchEvent(new Event('click'));
  cleanup();
  vi.useRealTimers();
});

describe('SwipeRow (A-07)', () => {
  it('droite au-delà de 40 % : fond vert, seuil, puis terminer avec succès haptique (critères 1, 14)', async () => {
    const { row, calls, onCommit } = setup();
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 100, 31, 200);
    expect(row.querySelector('.ct-swipe-row__under--right')).toHaveTextContent('Terminer');
    expect(calls).toEqual([]);
    touch(row, 'pointermove', 200, 31, 400);
    expect(calls).toEqual(['threshold']);
    touch(row, 'pointermove', 220, 31, 450);
    expect(calls).toEqual(['threshold']);
    await act(async () => {
      touch(row, 'pointerup', 220, 31, 500);
      await Promise.resolve();
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['threshold', 'commit', 'succeeded']);
    expect(row.querySelector('.ct-swipe-row__under--right')).toBeNull();
  });

  it('en deçà de 40 % et lent : retour sans effet (critère 1)', () => {
    const { row, calls, onCommit } = setup();
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 120, 30, 1000);
    touch(row, 'pointerup', 120, 30, 2000);
    expect(onCommit).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('geste rapide (40 px à plus de 0,5 px/ms) : validé sans mouvement intermédiaire', async () => {
    const { row, onCommit } = setup();
    touch(row, 'pointerdown', 20, 30, 0);
    await act(async () => {
      touch(row, 'pointerup', 70, 30, 60);
      await Promise.resolve();
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('cas d’usage en échec : aucun retour de succès, la ligne revient (critère 18)', async () => {
    const onCommit = vi.fn(() => Promise.resolve(false));
    const { row, calls } = setup({ right: { label: 'Terminer', tone: 'complete', onCommit } });
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 250, 30, 100);
    await act(async () => {
      touch(row, 'pointerup', 250, 30, 150);
      await Promise.resolve();
    });
    expect(calls).toEqual(['threshold', 'commit']);
    expect(row.querySelector('.ct-swipe-row__under--right')).toBeNull();
  });

  it('cas d’usage qui rejette : traité comme un échec, sans succès haptique', async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error('base')));
    const { row, calls } = setup({ right: { label: 'Terminer', tone: 'complete', onCommit } });
    touch(row, 'pointerdown', 20, 30, 0);
    await act(async () => {
      touch(row, 'pointerup', 250, 30, 50);
      await Promise.resolve();
    });
    expect(calls).not.toContain('succeeded');
  });

  it('tâche terminée : « Rouvrir », fond neutre (critère 2)', () => {
    const { row } = setup({ right: { label: 'Rouvrir', tone: 'reopen', onCommit: () => Promise.resolve(true) } });
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 90, 30, 100);
    const under = row.querySelector('.ct-swipe-row__under--right');
    expect(under).toHaveTextContent('Rouvrir');
    expect(under).toHaveAttribute('data-tone', 'reopen');
  });

  it('gauche à 62 px : la ligne reste ouverte avec ses boutons, haptique d’ouverture (critère 3)', () => {
    const { row, calls, onSelect } = setup();
    touch(row, 'pointerdown', 300, 30, 0);
    touch(row, 'pointermove', 200, 30, 500);
    touch(row, 'pointerup', 200, 30, 600);
    fireEvent.click(row); // le clic synthétique qui suit un balayage est avalé
    expect(calls).toEqual(['open']);
    expect(row).toHaveAttribute('data-open', 'true');
    expect(row.querySelectorAll('.ct-swipe-row__button')).toHaveLength(2);
    const front = row.querySelector<HTMLElement>('.ct-swipe-row__front');
    expect(front?.style.transform).toBe(`translateX(-${String(SWIPE_ROW_RULES.actionWidthPx * 2)}px)`);
    fireEvent.click(row.querySelector('[data-action="postpone"]') as Element);
    expect(onSelect).toHaveBeenCalledWith('postpone');
    expect(row).not.toHaveAttribute('data-open');
  });

  it('gauche sous 62 px et lent : la ligne se referme', () => {
    const { row, calls } = setup();
    touch(row, 'pointerdown', 300, 30, 0);
    touch(row, 'pointermove', 260, 30, 800);
    touch(row, 'pointerup', 260, 30, 900);
    expect(calls).toEqual([]);
    expect(row).not.toHaveAttribute('data-open');
  });

  it('une seule ligne ouverte dans un groupe (critère 3)', () => {
    render(
      <SwipeRowGroup>
        {['a', 'b'].map((id) => (
          <SwipeRow key={id} rowId={id} title={`Tâche ${id}`} right={null} left={actions(vi.fn())} onLongPress={null} disabled={false}>
            <p>{id}</p>
          </SwipeRow>
        ))}
      </SwipeRowGroup>,
    );
    const [first, second] = Array.from(document.querySelectorAll<HTMLElement>('.ct-swipe-row')) as [HTMLElement, HTMLElement];
    sized(first);
    sized(second);
    touch(first, 'pointerdown', 300, 30, 0);
    touch(first, 'pointermove', 200, 30, 100);
    touch(first, 'pointerup', 200, 30, 150);
    expect(first).toHaveAttribute('data-open', 'true');
    touch(second, 'pointerdown', 300, 30, 1000);
    touch(second, 'pointermove', 200, 30, 1100);
    touch(second, 'pointerup', 200, 30, 1150);
    expect(second).toHaveAttribute('data-open', 'true');
    expect(first).not.toHaveAttribute('data-open');
  });

  it('un toucher sur un bouton ne referme pas avant le clic ; un toucher ailleurs referme', () => {
    const { row, onSelect } = setup();
    touch(row, 'pointerdown', 300, 30, 0);
    touch(row, 'pointermove', 200, 30, 100);
    touch(row, 'pointerup', 200, 30, 150);
    fireEvent.click(row); // le clic synthétique qui suit un balayage est avalé
    const button = row.querySelector('[data-action="delete"]') as Element;
    fireEvent.pointerDown(button);
    expect(row).toHaveAttribute('data-open', 'true');
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith('delete');
    touch(row, 'pointerdown', 300, 30, 1000);
    touch(row, 'pointermove', 200, 30, 1100);
    touch(row, 'pointerup', 200, 30, 1150);
    expect(row).toHaveAttribute('data-open', 'true');
    fireEvent.pointerDown(document.body);
    expect(row).not.toHaveAttribute('data-open');
  });

  it('appui long de 500 ms sans bouger : appelé avec retour haptique (critère 8)', () => {
    vi.useFakeTimers();
    const { row, calls, onLongPress } = setup();
    touch(row, 'pointerdown', 100, 30, 0);
    vi.advanceTimersByTime(SWIPE_ROW_RULES.longPressMs - 1);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['longPress']);
    touch(row, 'pointerup', 100, 30, 520);
  });

  it('appui long : un déplacement de plus de 8 px l’annule', () => {
    vi.useFakeTimers();
    const { row, onLongPress } = setup();
    touch(row, 'pointerdown', 100, 30, 0);
    touch(row, 'pointermove', 100, 40, 100);
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('sans appui long (Semaine) : rien ne se déclenche à 500 ms', () => {
    vi.useFakeTimers();
    const { row, calls } = setup({ onLongPress: null });
    touch(row, 'pointerdown', 100, 30, 0);
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([]);
  });

  it('défilement vertical : aucun geste (critère 10)', () => {
    const { row, onCommit } = setup();
    touch(row, 'pointerdown', 20, 300, 0);
    touch(row, 'pointermove', 40, 330, 100);
    touch(row, 'pointermove', 300, 340, 200);
    touch(row, 'pointerup', 300, 340, 250);
    expect(onCommit).not.toHaveBeenCalled();
    expect(row.querySelector('.ct-swipe-row__under')).toBeNull();
  });

  it('diagonale sous le rapport 2 pour 1 : ignorée (critère 10)', () => {
    const { row, onCommit } = setup();
    touch(row, 'pointerdown', 20, 100, 0);
    touch(row, 'pointermove', 140, 180, 100);
    touch(row, 'pointerup', 200, 200, 150);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('pointercancel : le geste est abandonné', () => {
    const { row, onCommit } = setup();
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 200, 30, 100);
    touch(row, 'pointercancel', 200, 30, 110);
    touch(row, 'pointerup', 300, 30, 120);
    expect(onCommit).not.toHaveBeenCalled();
    expect(row.querySelector('.ct-swipe-row__under')).toBeNull();
  });

  it('la souris est ignorée (critère 12)', () => {
    vi.useFakeTimers();
    const { row, onCommit, onLongPress } = setup();
    touch(row, 'pointerdown', 20, 30, 0, 'mouse');
    touch(row, 'pointermove', 300, 30, 100, 'mouse');
    vi.advanceTimersByTime(1000);
    touch(row, 'pointerup', 300, 30, 1100, 'mouse');
    expect(onCommit).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('un départ dans un champ de saisie est ignoré', () => {
    const { row, onCommit } = setup();
    const input = screen.getByLabelText('champ');
    touch(input, 'pointerdown', 20, 30, 0);
    touch(input, 'pointermove', 300, 30, 100);
    touch(input, 'pointerup', 300, 30, 150);
    expect(onCommit).not.toHaveBeenCalled();
    expect(row.querySelector('.ct-swipe-row__under')).toBeNull();
  });

  it('désactivée (mode édition, glisser) : aucun geste ni groupe d’actions (critère 9)', () => {
    vi.useFakeTimers();
    const { row, onCommit, onLongPress } = setup({ disabled: true });
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 300, 30, 100);
    vi.advanceTimersByTime(1000);
    touch(row, 'pointerup', 300, 30, 1100);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('désactivée pendant le geste : le geste est abandonné', () => {
    const onCommit = vi.fn(() => Promise.resolve(true));
    const props = { rowId: 'a', title: 'Courses', right: { label: 'Terminer', tone: 'complete' as const, onCommit }, left: [], onLongPress: null };
    const { rerender } = render(
      <SwipeRow {...props} disabled={false}>
        <p>{CONTENT}</p>
      </SwipeRow>,
    );
    const row = document.querySelector<HTMLElement>('.ct-swipe-row') as HTMLElement;
    sized(row);
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 100, 30, 50);
    rerender(
      <SwipeRow {...props} disabled>
        <p>{CONTENT}</p>
      </SwipeRow>,
    );
    touch(row, 'pointerup', 300, 30, 100);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('sans action de droite, pas de balayage à droite ; sans bouton, pas de balayage à gauche (routine)', () => {
    const { row } = setup({ right: null });
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 200, 30, 100);
    expect(row.querySelector('.ct-swipe-row__under')).toBeNull();
    touch(row, 'pointerup', 200, 30, 150);
    cleanup();
    const second = setup({ left: [] });
    touch(second.row, 'pointerdown', 300, 30, 0);
    touch(second.row, 'pointermove', 100, 30, 100);
    expect(second.row.querySelectorAll('.ct-swipe-row__button')).toHaveLength(0);
  });

  it('le groupe d’actions VoiceOver : nommé, après le contenu, mêmes cas d’usage (critères 16, 17)', () => {
    const { onSelect, row } = setup();
    const group = screen.getByRole('group', { name: 'Actions : Courses' });
    expect(group).not.toHaveAttribute('aria-expanded'); // ARIA 1.2 : pas pour role=group, VoiceOver annoncerait « réduit »
    expect(row.lastElementChild).toBe(group);
    fireEvent.click(screen.getByRole('button', { name: 'Reporter : Courses' }));
    expect(onSelect).toHaveBeenCalledWith('postpone');
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer : Courses' }));
    expect(onSelect).toHaveBeenCalledWith('delete');
  });

  it('le groupe n’a jamais aria-expanded, ligne ouverte ou non (critère 17)', () => {
    const { row } = setup();
    touch(row, 'pointerdown', 300, 30, 0);
    touch(row, 'pointermove', 200, 30, 100);
    touch(row, 'pointerup', 200, 30, 150);
    expect(row).toHaveAttribute('data-open', 'true');
    expect(screen.getByRole('group', { name: 'Actions : Courses' })).not.toHaveAttribute('aria-expanded');
  });

  it('pendant le cas d’usage du premier balayage, un second balayage est ignoré (QA D1)', async () => {
    const onCommit = vi.fn(() => new Promise<boolean>(() => undefined));
    const { row } = setup({ right: { label: 'Terminer', tone: 'complete', onCommit } });
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 250, 30, 100);
    await act(async () => {
      touch(row, 'pointerup', 250, 30, 150);
      await Promise.resolve();
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    touch(row, 'pointerdown', 20, 30, 1000);
    touch(row, 'pointermove', 250, 30, 1100);
    await act(async () => {
      touch(row, 'pointerup', 250, 30, 1150);
      await Promise.resolve();
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('le nom accessible peut être fourni par l’action (« Planifier aujourd’hui : … »)', () => {
    setup({ left: [{ id: 'today', label: 'Aujourd’hui', ariaLabel: 'Planifier aujourd’hui : Courses', icon: null, tone: 'soft', onSelect: vi.fn() }] });
    expect(screen.getByRole('button', { name: 'Planifier aujourd’hui : Courses' })).toBeInTheDocument();
  });

  it('marque la ligne pour la semaine (data-row-gesture) et pour le focus voisin', () => {
    const { row } = setup();
    expect(row).toHaveAttribute('data-row-gesture');
    expect(row).toHaveAttribute('data-swipe-row', 'a');
  });
});
