import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChoiceDialog } from './ChoiceDialog';

afterEach(cleanup);

const TITLE = 'Modifier « Loyer » ?';
const DESCRIPTION = 'Cette tâche se répète.';
const OPTIONS = [
  { id: 'occurrence', label: 'Cette occurrence' },
  { id: 'following', label: 'Toutes les suivantes' },
] as const;

function renderDialog() {
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  render(<ChoiceDialog title={TITLE} description={DESCRIPTION} options={OPTIONS} onChoose={onChoose} onCancel={onCancel} />);
  return { onChoose, onCancel };
}

describe('ChoiceDialog (T-10)', () => {
  it('boîte accessible nommée par la question, focus sur « Annuler »', () => {
    renderDialog();
    expect(screen.getByRole('alertdialog', { name: TITLE })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Annuler' })).toHaveFocus();
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
  });

  it('le corps décrit la boîte (aria-describedby) ; sans corps, aucun lien', () => {
    renderDialog();
    expect(screen.getByRole('alertdialog', { name: TITLE })).toHaveAccessibleDescription(DESCRIPTION);
    cleanup();
    render(<ChoiceDialog title={TITLE} options={OPTIONS} onChoose={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('alertdialog')).not.toHaveAttribute('aria-describedby');
  });

  it('chaque option est transmise avec son identifiant', () => {
    const { onChoose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cette occurrence' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toutes les suivantes' }));
    expect(onChoose.mock.calls).toEqual([['occurrence'], ['following']]);
  });

  it('« Annuler » et Échap annulent sans choisir', () => {
    const { onChoose, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onChoose).not.toHaveBeenCalled();
  });
});
