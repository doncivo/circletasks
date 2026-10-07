import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(cleanup);

const DELETE = 'Supprimer';
const QUESTION = 'Supprimer « Courses » ?';
const DESCRIPTION = 'Conservée 30 jours.';

function renderDialog() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog title={QUESTION} description={DESCRIPTION} confirmLabel={DELETE} onConfirm={onConfirm} onCancel={onCancel} />,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmDialog (T-08)', () => {
  it('boîte accessible nommée par la question, focus sur « Annuler »', () => {
    renderDialog();
    expect(screen.getByRole('alertdialog', { name: QUESTION })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Annuler' })).toHaveFocus();
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
  });

  it('le corps décrit la boîte (aria-describedby) ; sans corps, aucun lien', () => {
    renderDialog();
    expect(screen.getByRole('alertdialog', { name: QUESTION })).toHaveAccessibleDescription(DESCRIPTION);
    cleanup();
    render(<ConfirmDialog title={QUESTION} confirmLabel={DELETE} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('alertdialog')).not.toHaveAttribute('aria-describedby');
  });

  it('« Supprimer » confirme, « Annuler » annule', () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('Échap annule sans confirmer', () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Tab reste piégé dans la boîte', () => {
    renderDialog();
    const confirm = screen.getByRole('button', { name: 'Supprimer' });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Annuler' })).toHaveFocus();
  });
});
