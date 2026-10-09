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

describe('DeleteTaskConfirm : tâche liée à un rappel Apple (K-06 critère 7)', () => {
  it('la confirmation nomme Rappels ; une tâche ordinaire garde sa confirmation', () => {
    const onConfirm = vi.fn();
    render(<DeleteTaskConfirm task={{ title: 'Pain', recurrenceId: null, source: 'apple_reminders', externalId: 'R-1' }} onConfirm={onConfirm} onCancel={() => undefined} />);
    expect(screen.getByRole('alertdialog', { name: 'Supprimer aussi dans Rappels ?' })).toBeInTheDocument();
    expect(screen.getByText('« Pain » est liée à un rappel : il sera aussi supprimé dans Rappels.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    expect(onConfirm).toHaveBeenCalledWith();
    cleanup();
    render(<DeleteTaskConfirm task={{ title: 'Pain', recurrenceId: null, source: 'apple_reminders', externalId: null }} onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByRole('alertdialog', { name: 'Supprimer « Pain » ?' })).toBeInTheDocument();
    cleanup();
    render(<DeleteTaskConfirm task={{ title: 'Pain', recurrenceId: null, source: 'local', externalId: null }} onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(screen.queryByText(/Rappels/)).not.toBeInTheDocument();
  });
});
