import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MoveRight, X } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { touch } from '../features/tasks/gestureTestKit';
import { Icon } from './Icon';
import { SwipeRow, SwipeRowGroup, SWIPE_ROW_RULES, type RowGestureFeedback, type SwipeRowAction, type SwipeRowProps } from './SwipeRow';

/** A-07, passe QA : seuils à la limite, geste rapide court, ligne ouverte, appui long, animations réduites. */

const TITLE = 'Courses';
const COMPLETE = 'Terminer';
const CONTENT = 'contenu';

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

function buttons(onSelect: (id: string) => void): SwipeRowAction[] {
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
    <SwipeRow rowId="a" title={TITLE} right={{ label: COMPLETE, tone: 'complete', onCommit }} left={buttons(onSelect)} onLongPress={onLongPress} disabled={false} feedback={feedback} {...props}>
      <p>{CONTENT}</p>
    </SwipeRow>,
  );
  const row = document.querySelector<HTMLElement>('.ct-swipe-row') as HTMLElement;
  sized(row);
  return { row, calls, onCommit, onSelect, onLongPress };
}

async function release(row: HTMLElement, x: number, y: number, at: number): Promise<void> {
  await act(async () => {
    touch(row, 'pointerup', x, y, at);
    await Promise.resolve();
  });
}

afterEach(() => {
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  window.dispatchEvent(new Event('click'));
  cleanup();
  vi.useRealTimers();
});

describe('A-07 QA : seuils à la limite', () => {
  it('A-07 critère 1 : 9 px horizontaux ne prennent pas le geste (aucune révélation, aucun effet)', async () => {
    const { row, calls, onCommit } = setup();
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 29, 30, 50);
    expect(row.querySelector('.ct-swipe-row__under')).toBeNull();
    await release(row, 29, 30, 60);
    expect(onCommit).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('A-07 critère 1 : 10 px horizontaux prennent le geste (limite incluse)', () => {
    const { row } = setup();
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 30, 30, 50);
    expect(row.querySelector('.ct-swipe-row__under--right')).not.toBeNull();
  });

  it('A-07 critère 1 : 9 px vers la gauche, même vite, n’ouvre pas la ligne', async () => {
    const { row, calls } = setup();
    touch(row, 'pointerdown', 300, 30, 0);
    await release(row, 291, 30, 5);
    expect(row).not.toHaveAttribute('data-open');
    expect(calls).toEqual([]);
  });

  it('A-07 critère 1 : 39 % de la largeur, lent : ni seuil haptique ni validation', async () => {
    const { row, calls, onCommit } = setup();
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 176, 30, 1000); // 156 px sur 400 = 39 %
    expect(calls).toEqual([]);
    await release(row, 176, 30, 2000);
    expect(onCommit).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(row.querySelector('.ct-swipe-row__under')).toBeNull();
  });

  it('A-07 critère 1 : 40 % pile, lent : validé avec le seuil haptique', async () => {
    const { row, calls, onCommit } = setup();
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 180, 30, 1000); // 160 px sur 400 = 40 %
    expect(calls).toEqual(['threshold']);
    await release(row, 180, 30, 2000);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('A-07 critère 1 : revenir sous 40 % avant de lâcher annule la validation', async () => {
    const { row, onCommit } = setup();
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 220, 30, 1000);
    touch(row, 'pointermove', 100, 30, 2000);
    await release(row, 100, 30, 3000);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('A-07 critère 1 : geste rapide trop court (39 px) : sans effet', async () => {
    const { row, onCommit } = setup();
    touch(row, 'pointerdown', 20, 30, 0);
    await release(row, 59, 30, 10);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('A-07 critère 1 : 40 px à 0,5 px/ms pile : validé ; à 0,4 px/ms : sans effet', async () => {
    const fast = setup();
    touch(fast.row, 'pointerdown', 20, 30, 0);
    await release(fast.row, 60, 30, 80);
    expect(fast.onCommit).toHaveBeenCalledTimes(1);
    cleanup();
    const slow = setup();
    touch(slow.row, 'pointerdown', 20, 30, 0);
    await release(slow.row, 60, 30, 100);
    expect(slow.onCommit).not.toHaveBeenCalled();
  });

  it('A-07 critère 3 : 61 px vers la gauche, lent : refermé ; 62 px : ouvert', () => {
    const under = setup();
    touch(under.row, 'pointerdown', 300, 30, 0);
    touch(under.row, 'pointermove', 239, 30, 1000);
    touch(under.row, 'pointerup', 239, 30, 1100);
    expect(under.row).not.toHaveAttribute('data-open');
    cleanup();
    const exact = setup();
    touch(exact.row, 'pointerdown', 300, 30, 0);
    touch(exact.row, 'pointermove', 238, 30, 1000);
    touch(exact.row, 'pointerup', 238, 30, 1100);
    expect(exact.row).toHaveAttribute('data-open', 'true');
  });

  it('A-07 critère 3 : geste rapide trop court vers la gauche (39 px) : refermé', () => {
    const { row, calls } = setup();
    touch(row, 'pointerdown', 300, 30, 0);
    touch(row, 'pointerup', 261, 30, 10);
    expect(row).not.toHaveAttribute('data-open');
    expect(calls).toEqual([]);
  });

  it('A-07 critère 10 : 12 px verticaux avant la prise abandonnent ; 13 px aussi, mais 12 px sous un horizontal fort gardent le geste', () => {
    const { row } = setup();
    touch(row, 'pointerdown', 20, 100, 0);
    touch(row, 'pointermove', 24, 113, 50); // 13 px vertical dominant : défilement
    touch(row, 'pointermove', 200, 113, 100);
    expect(row.querySelector('.ct-swipe-row__under')).toBeNull();
    touch(row, 'pointerup', 200, 113, 120);
    cleanup();
    const second = setup();
    touch(second.row, 'pointerdown', 20, 100, 0);
    touch(second.row, 'pointermove', 60, 108, 50); // 40 px contre 8 px : rapport > 2 pour 1
    expect(second.row.querySelector('.ct-swipe-row__under--right')).not.toBeNull();
  });

  it('A-07 critère 10 : un défilement vertical ne bloque pas le mouvement de page (touchmove non annulé)', () => {
    const { row } = setup();
    touch(row, 'pointerdown', 20, 100, 0);
    touch(row, 'pointermove', 22, 140, 50);
    const move = new Event('touchmove', { bubbles: true, cancelable: true });
    window.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(false);
    touch(row, 'pointerup', 22, 140, 80);
  });

  it('A-07 critère 10 : un balayage pris bloque le mouvement de page, et plus après le lâcher', () => {
    const { row } = setup();
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 120, 30, 50);
    const during = new Event('touchmove', { bubbles: true, cancelable: true });
    window.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);
    touch(row, 'pointerup', 120, 30, 2000);
    const after = new Event('touchmove', { bubbles: true, cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});

describe('A-07 QA : ligne ouverte et groupe', () => {
  function group() {
    render(
      <SwipeRowGroup>
        {['a', 'b', 'c'].map((id) => (
          <SwipeRow key={id} rowId={id} title={`Tâche ${id}`} right={null} left={buttons(vi.fn())} onLongPress={() => undefined} disabled={false}>
            <p>{id}</p>
          </SwipeRow>
        ))}
      </SwipeRowGroup>,
    );
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.ct-swipe-row'));
    rows.forEach(sized);
    return rows as [HTMLElement, HTMLElement, HTMLElement];
  }

  function openRow(row: HTMLElement, at: number): void {
    touch(row, 'pointerdown', 300, 30, at);
    touch(row, 'pointermove', 200, 30, at + 100);
    touch(row, 'pointerup', 200, 30, at + 150);
  }

  it('A-07 critère 3 : trois ouvertures successives, une seule ligne reste ouverte (la dernière)', () => {
    const [a, b, c] = group();
    openRow(a, 0);
    openRow(b, 1000);
    openRow(c, 2000);
    expect(a).not.toHaveAttribute('data-open');
    expect(b).not.toHaveAttribute('data-open');
    expect(c).toHaveAttribute('data-open', 'true');
    expect(document.querySelectorAll('[data-open="true"]')).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Actions : Tâche c' })).not.toHaveAttribute('aria-expanded');
    expect(screen.getByRole('group', { name: 'Actions : Tâche a' })).not.toHaveAttribute('aria-expanded');
  });

  it('A-07 critère 3 : un simple toucher sur une autre ligne referme la ligne ouverte', () => {
    const [a, b] = group();
    openRow(a, 0);
    expect(a).toHaveAttribute('data-open', 'true');
    touch(b, 'pointerdown', 100, 30, 1000);
    touch(b, 'pointerup', 100, 30, 1050);
    expect(a).not.toHaveAttribute('data-open');
  });

  it('A-07 critère 3 : balayer vers la droite (24 px) referme la ligne ouverte sans rien lancer', () => {
    const { row, onSelect, calls } = setup();
    touch(row, 'pointerdown', 300, 30, 0);
    touch(row, 'pointermove', 200, 30, 100);
    touch(row, 'pointerup', 200, 30, 150);
    expect(row).toHaveAttribute('data-open', 'true');
    touch(row, 'pointerdown', 150, 30, 2000);
    touch(row, 'pointermove', 180, 30, 2500);
    touch(row, 'pointerup', 180, 30, 2600);
    expect(row).not.toHaveAttribute('data-open');
    expect(onSelect).not.toHaveBeenCalled();
    expect(calls).toEqual(['open']);
  });

  it('A-07 critère 3 : un défilement de la page referme la ligne ouverte', () => {
    const { row } = setup();
    touch(row, 'pointerdown', 300, 30, 0);
    touch(row, 'pointermove', 200, 30, 100);
    touch(row, 'pointerup', 200, 30, 150);
    expect(row).toHaveAttribute('data-open', 'true');
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(row).not.toHaveAttribute('data-open');
  });

  it('A-07 critère 8 : l’appui long ne se déclenche pas sur une ligne ouverte', () => {
    vi.useFakeTimers();
    const { row, onLongPress, calls } = setup();
    touch(row, 'pointerdown', 300, 30, 0);
    touch(row, 'pointermove', 200, 30, 100);
    touch(row, 'pointerup', 200, 30, 150);
    touch(row, 'pointerdown', 100, 30, 1000);
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(calls).toEqual(['open']);
    touch(row, 'pointerup', 100, 30, 2000);
  });

  it('A-07 critère 8 : appui long, puis relâcher : aucune ouverture ni validation', () => {
    vi.useFakeTimers();
    const { row, onCommit, onLongPress } = setup();
    touch(row, 'pointerdown', 100, 30, 0);
    vi.advanceTimersByTime(SWIPE_ROW_RULES.longPressMs);
    touch(row, 'pointermove', 300, 30, 600);
    touch(row, 'pointerup', 300, 30, 650);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(row).not.toHaveAttribute('data-open');
  });

  it('A-07 critère 8 : 8 px de dérive gardent l’appui long, 9 px l’annulent', () => {
    vi.useFakeTimers();
    const kept = setup();
    touch(kept.row, 'pointerdown', 100, 30, 0);
    touch(kept.row, 'pointermove', 108, 30, 100);
    vi.advanceTimersByTime(500);
    expect(kept.onLongPress).toHaveBeenCalledTimes(1);
    touch(kept.row, 'pointerup', 108, 30, 700);
    cleanup();
    const lost = setup();
    touch(lost.row, 'pointerdown', 100, 30, 0);
    touch(lost.row, 'pointermove', 109, 30, 100);
    vi.advanceTimersByTime(1000);
    expect(lost.onLongPress).not.toHaveBeenCalled();
  });

  it('A-07 critère 8 : relâcher avant 500 ms n’ouvre pas la fiche', () => {
    vi.useFakeTimers();
    const { row, onLongPress } = setup();
    touch(row, 'pointerdown', 100, 30, 0);
    vi.advanceTimersByTime(499);
    touch(row, 'pointerup', 100, 30, 499);
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('A-07 critère 12 : un clic de souris sur un bouton masqué fonctionne comme au clavier, sans geste', () => {
    const { row, onSelect } = setup();
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointerup', 20, 30, 20);
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer : Courses' }));
    expect(onSelect).toHaveBeenCalledWith('delete');
    expect(row).not.toHaveAttribute('data-open');
  });
});

describe('A-07 QA : cas d’usage lent ou en erreur', () => {
  it('A-07 critère 18 : un échec n’émet que seuil et validation, la ligne est replacée', async () => {
    const onCommit = vi.fn(() => Promise.resolve(false));
    const { row, calls } = setup({ right: { label: 'Terminer', tone: 'complete', onCommit } });
    touch(row, 'pointerdown', 20, 30, 0);
    touch(row, 'pointermove', 250, 30, 100);
    await release(row, 250, 30, 150);
    expect(calls).toEqual(['threshold', 'commit']);
    expect(row.querySelector<HTMLElement>('.ct-swipe-row__front')?.style.transform).toBe('');
  });

});

describe('A-07 QA : animations réduites (critère 13)', () => {
  const css = readFileSync(join(process.cwd(), 'src', 'ui', 'SwipeRow.css'), 'utf8');

  it('A-07 critère 13 : la transition de la ligne est coupée sous prefers-reduced-motion', () => {
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block?.[1]).toMatch(/\.ct-swipe-row__front\[data-animate='true'\][\s\S]*transition:\s*none/);
  });

  it('A-07 critère 13 : aucune autre animation ni transition dans SwipeRow.css hors du bloc animé', () => {
    const withoutReduced = css.replace(/@media \(prefers-reduced-motion: reduce\)[\s\S]*$/, '');
    const motions = withoutReduced.match(/(transition|animation)\s*:/g) ?? [];
    expect(motions).toHaveLength(1);
  });
});
