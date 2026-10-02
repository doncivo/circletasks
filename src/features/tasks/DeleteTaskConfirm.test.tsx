import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asEntityId, type RecurrenceId } from '../../domain/types';
import { DeleteTaskConfirm } from './DeleteTaskConfirm';

afterEach(cleanup);

const TITLE = 'Loyer';
const RECURRENCE = asEntityId<RecurrenceId>('00000000-0000-4000-8000-000000000001');

describe('DeleteTaskConfirm (T-08, T-10 critère 7)', () => {
  it('tâche simple : confirmation unique, sans portée', () => {
    const onConfirm = vi.fn();
    render(<DeleteTaskConfirm task={{ title: TITLE, recurrenceId: null }} onConfirm={onConfirm} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    expect(onConfirm).toHaveBeenCalledWith();
  });

  it('occurrence récurrente : « Cette occurrence » / « Toutes les suivantes » / « Annuler »', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<DeleteTaskConfirm task={{ title: TITLE, recurrenceId: RECURRENCE }} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByRole('alertdialog', { name: 'Supprimer « Loyer » ?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cette occurrence' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toutes les suivantes' }));
    expect(onConfirm.mock.calls).toEqual([['occurrence'], ['following']]);
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
