import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNoticeStore } from '../app/notice';
import { renderEvents, setupEvents } from '../events/testKit';
import { renderRoutines } from '../routines/testKit';
import { CREATE_NOT_READY_MS, TaskCreateSheet } from '../tasks/TaskCreateSheet';
import { mockViewport, renderToday, setupToday, teardownToday, type TodayHarness } from '../today/testKit';

/** Q-05, revue : formulaire figé pendant une écriture lente (QA D1) et ouverture depuis Événements et Routines (QA D2). */
describe('Q-05 revue : écriture lente et points d’entrée', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    mockViewport(440);
    h = await setupToday('ab05');
  });
  afterEach(async () => {
    vi.useRealTimers();
    await teardownToday(h);
  });

  it('Q-05 critère 2 (QA D1) : pendant « La base n’est pas prête » le formulaire est figé, aucune modification n’est perdue en silence ; il se libère à la fin de l’écriture', async () => {
    const finishers: ((ok: boolean) => void)[] = [];
    const onCreate = vi.fn((input: { title: string }) => {
      void input;
      return new Promise<boolean>((resolve) => finishers.push(resolve));
    });
    const onClose = vi.fn();
    render(
      <AppContainerProvider container={h.container}>
        <TaskCreateSheet viewedDate={h.today} today={h.today} spaces={useAppStore.getState().spaces} initialSpaceId={SPACE_PERSO_ID} onClose={onClose} onCreate={onCreate} />
      </AppContainerProvider>,
    );
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Acheter du pain' } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREATE_NOT_READY_MS);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('ne peut pas être modifié');
    // Figé : le champ est en lecture seule et une modification n'est pas prise en compte (rien n'est perdu sans le dire).
    expect(screen.getByLabelText('Titre')).toHaveAttribute('readonly');
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Acheter du pain complet' } });
    expect(screen.getByLabelText('Titre')).toHaveValue('Acheter du pain');
    expect(screen.getByLabelText('Titre').closest('.ct-task-sheet__fields')).toHaveAttribute('inert');
    expect(onCreate).toHaveBeenCalledTimes(1);
    // L'écriture est refusée : le formulaire se libère, le texte modifié part à « Enregistrer ».
    await act(async () => {
      finishers[0]?.(false);
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Titre')).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText('Titre').closest('.ct-task-sheet__fields')).not.toHaveAttribute('inert');
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Acheter du pain complet' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
      await Promise.resolve();
    });
    expect(onCreate.mock.calls.map(([input]) => input.title)).toEqual(['Acheter du pain', 'Acheter du pain complet']);
  });

  /** Feuille ouverte sur un onCreate piloté à la main, texte saisi, « Enregistrer » touché, délai de 2 s écoulé (« La base n’est pas prête »). */
  async function openStuck(onClose: () => void) {
    const finishers: ((ok: boolean) => void)[] = [];
    const onCreate = vi.fn((input: { title: string }) => {
      void input;
      return new Promise<boolean>((resolve) => finishers.push(resolve));
    });
    const view = render(
      <AppContainerProvider container={h.container}>
        <TaskCreateSheet viewedDate={h.today} today={h.today} spaces={useAppStore.getState().spaces} initialSpaceId={SPACE_PERSO_ID} onClose={onClose} onCreate={onCreate} />
      </AppContainerProvider>,
    );
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Appeler le notaire' } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREATE_NOT_READY_MS);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('La base n’est pas prête');
    return { finishers, onCreate, view };
  }

  it('Q-05 critère 2 (revue) : onCreate qui ne se résout jamais, « Réessayer » relance une vraie écriture (pas la même attente) avec le même texte', async () => {
    const onClose = vi.fn();
    const { finishers, onCreate } = await openStuck(onClose);
    expect(onCreate).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
      await Promise.resolve();
    });
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate.mock.calls[1]?.[0].title).toBe('Appeler le notaire');
    // L'ancien message est parti, la nouvelle écriture décide de la feuille.
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => {
      finishers[1]?.(true);
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // L'ancienne écriture aboutit enfin : le doublon possible est dit, la feuille n'est pas refermée une seconde fois.
    await act(async () => {
      finishers[0]?.(true);
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useNoticeStore.getState().notice?.text).toContain('deux fois');
  });

  it('Q-05 critère 2 (revue) : feuille fermée pendant l’attente, la fin de l’écriture est dite (enregistrée, ou non enregistrée avec la marche à suivre)', async () => {
    const onClose = vi.fn();
    const first = await openStuck(onClose);
    first.view.unmount();
    useNoticeStore.getState().clear();
    await act(async () => {
      first.finishers[0]?.(true);
      await Promise.resolve();
    });
    expect(useNoticeStore.getState().notice?.text).toBe('La tâche « Appeler le notaire » a été enregistrée après la fermeture de la feuille.');
    expect(onClose).not.toHaveBeenCalled();
    vi.useRealTimers();
    const second = await openStuck(onClose);
    second.view.unmount();
    useNoticeStore.getState().clear();
    await act(async () => {
      second.finishers[0]?.(false);
      await Promise.resolve();
    });
    expect(useNoticeStore.getState().notice?.text).toContain('n’a pas pu être enregistrée');
    expect(useNoticeStore.getState().notice?.text).toContain('« + »');
  });

  it('Q-05 critère 3 : ouverture depuis Événements puis Routines : le champ est focalisé dans le geste du toucher', async () => {
    const e = await setupEvents('cd05');
    renderEvents(e.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter un événement' }));
    expect(screen.getByLabelText('Titre')).toHaveFocus();
    cleanup();
    await e.db.close();
    const r = await setupToday('ef05');
    renderRoutines(r.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une routine' }));
    expect(screen.getByLabelText('Nom de la routine')).toHaveFocus();
    cleanup();
    await r.db.close();
  });

  it('Q-05 critère 3 (QA D2) : changement de segment Tâche, Événement, Routine : le champ du segment est focalisé dans le geste', async () => {
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
    expect(screen.getByLabelText('Titre')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Événement' }));
    expect(screen.getByLabelText('Titre')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Routine' }));
    expect(screen.getByLabelText('Nom de la routine')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Tâche' }));
    expect(screen.getByLabelText('Titre')).toHaveFocus();
  });
});
