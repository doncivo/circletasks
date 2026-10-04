import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock, type ManualClock } from '../../domain/clock';
import type { FocusWindowAction, FocusWindowState } from '../../platform/focus';
import { FocusView, type FocusVariant } from './FocusView';

const START = '2026-10-04T08:00:00.000Z';
const MIN = 60_000;

function stateOf(over: Partial<FocusWindowState['session']> = {}, rest: Partial<FocusWindowState> = {}): FocusWindowState {
  return {
    phase: 'running',
    session: { id: 's1', plannedMin: 25, startedAt: START, endedAt: null, pausedSec: 0, pausedAt: null, ...over },
    title: 'Envoyer la facture',
    time: '09:00',
    spaceName: 'Pro',
    canFinishTask: true,
    today: { minutes: 0, sessions: 0 },
    sound: { enabled: false, nonce: 0 },
    endedMinutes: 0,
    locale: 'fr',
    ...rest,
  };
}

function setup(state: FocusWindowState, variant: FocusVariant = 'screen', at: string | number = Date.parse(START) + 9 * MIN + 26_000) {
  const clock: ManualClock = createManualClock(at);
  const actions: FocusWindowAction[] = [];
  const view = render(<FocusView state={state} variant={variant} clock={clock} onAction={(a) => actions.push(a)} />);
  /** Fait avancer l'horloge puis simule le retour au premier plan (le tic d'une seconde relit l'horloge). */
  const advance = (ms: number): void => {
    clock.advance(ms);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
  };
  return { clock, actions, advance, ...view };
}

afterEach(() => cleanup());

describe('Écran de session Focus (F-01, Focus.html)', () => {
  it('critère 11 : espace et heure de la tâche, titre ; sans heure, l’espace seul', () => {
    setup(stateOf());
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Envoyer la facture' })).toBeInTheDocument();
    expect(screen.getByText('09:00 ·', { exact: false })).toBeInTheDocument();
    cleanup();
    setup(stateOf({}, { time: null }));
    expect(screen.queryByText('09:00 ·', { exact: false })).not.toBeInTheDocument();
    expect(screen.getByText('Pro')).toBeInTheDocument();
  });

  it('critère 2 et 4 : 15:34 restantes sur 25 min, calculé depuis les horodatages ; l’anneau se vide', () => {
    const { container, advance } = setup(stateOf());
    expect(screen.getByRole('timer')).toHaveTextContent('15:34');
    expect(screen.getByText('restantes sur 25 min')).toBeInTheDocument();
    const arc = container.querySelector('.ct-focus__arc');
    expect(Number(arc?.getAttribute('stroke-dashoffset'))).toBeCloseTo(816.8 * (1 - 934 / 1500), 1);
    advance(30_000);
    expect(screen.getByRole('timer')).toHaveTextContent('15:04');
  });

  it('critère 5 : un saut de 40 minutes sans aucun tic (veille) donne le temps juste, jamais un compteur', () => {
    const { advance } = setup(stateOf({ plannedMin: 90 }));
    advance(40 * MIN);
    // 9 min 26 s + 40 min écoulées sur 90 min : 40:34 restantes.
    expect(screen.getByRole('timer')).toHaveTextContent('40:34');
  });

  it('critère 4 : « Libre » compte le temps écoulé et laisse l’anneau plein', () => {
    const { container } = setup(stateOf({ plannedMin: null }), 'screen', Date.parse(START) + 12 * MIN + 41_000);
    expect(screen.getByRole('timer')).toHaveTextContent('12:41');
    expect(screen.getByText('écoulées')).toBeInTheDocument();
    expect(container.querySelector('.ct-focus__arc')?.getAttribute('stroke-dashoffset')).toBe('0');
  });

  it('critère 4 : les pastilles 25 / 50 / 90 min et Libre, la durée en cours est sélectionnée', () => {
    const { actions } = setup(stateOf({ plannedMin: 50 }));
    const group = screen.getByRole('group', { name: 'Durée de la session' });
    expect(within(group).getByRole('button', { name: '50 min' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: '25 min' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(within(group).getByRole('button', { name: '90 min' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Libre' }));
    expect(actions).toEqual([
      { type: 'duration', minutes: 90 },
      { type: 'duration', minutes: null },
    ]);
  });

  it('critère 8 : « Terminer la tâche » envoie l’ordre ; absent si la tâche a disparu', () => {
    const { actions } = setup(stateOf());
    fireEvent.click(screen.getByRole('button', { name: 'Terminer la tâche' }));
    expect(actions).toEqual([{ type: 'finishTask' }]);
    cleanup();
    setup(stateOf({}, { canFinishTask: false, title: null }));
    expect(screen.queryByRole('button', { name: 'Terminer la tâche' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tâche supprimée' })).toBeInTheDocument();
  });

  it('critère 7 : la croix demande « Arrêter la session ? » ; « Continuer » ne change rien', () => {
    const { actions } = setup(stateOf());
    fireEvent.click(screen.getByRole('button', { name: 'Fermer Focus' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Arrêter la session ?' });
    expect(within(dialog).getByRole('button', { name: 'Arrêter et enregistrer 9 min' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continuer' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(actions).toEqual([]);
  });

  it('critère 7 : « Arrêter et enregistrer N min » envoie l’arrêt', () => {
    const { actions } = setup(stateOf());
    fireEvent.click(screen.getByRole('button', { name: 'Fermer Focus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Arrêter et enregistrer 9 min' }));
    expect(actions).toEqual([{ type: 'stop' }]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('critère 7 : sous une minute, l’arrêt est annoncé sans enregistrement', () => {
    setup(stateOf(), 'screen', Date.parse(START) + 20_000);
    fireEvent.click(screen.getByRole('button', { name: 'Fermer Focus' }));
    expect(screen.getByText('Moins d’une minute de concentration : la session ne sera pas enregistrée.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arrêter sans enregistrer' })).toBeInTheDocument();
  });

  it('critère 7 : la croix de la barre de titre (mini-fenêtre) ouvre la même confirmation', () => {
    const clock = createManualClock(Date.parse(START) + 5 * MIN);
    const view = render(<FocusView state={stateOf()} variant="window" clock={clock} onAction={() => undefined} closeRequests={0} />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    view.rerender(<FocusView state={stateOf()} variant="window" clock={clock} onAction={() => undefined} closeRequests={1} />);
    expect(screen.getByRole('alertdialog', { name: 'Arrêter la session ?' })).toBeInTheDocument();
  });

  it('critère 13 : temps en rôle timer sans annonce à la seconde, annonce du temps restant par minute, anneau décoratif', () => {
    const { container, advance } = setup(stateOf());
    const timer = screen.getByRole('timer');
    expect(timer).toHaveAttribute('aria-live', 'off');
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent('16 min restantes');
    advance(10_000); // même minute entamée : l’annonce ne change pas
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('16 min restantes');
    advance(60_000);
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('15 min restantes');
  });

  it('critère 13 : les boutons ont une zone tactile minimale de 44 pt (classe de style), la session est un repère nommé', () => {
    setup(stateOf());
    expect(screen.getByRole('region', { name: 'Session Focus' })).toBeInTheDocument();
  });

  it('signale une seule fois le terme atteint à la fenêtre principale', () => {
    const { actions, advance } = setup(stateOf({ plannedMin: 10 }), 'window', Date.parse(START) + 9 * MIN);
    expect(actions).toEqual([]);
    advance(2 * MIN);
    advance(1000);
    expect(actions.filter((a) => a.type === 'elapsed')).toHaveLength(1);
    expect(screen.getByRole('timer')).toHaveTextContent('00:00');
  });

  it('variantes : écran iPhone, mini-fenêtre PC et panneau portent leur classe', () => {
    for (const variant of ['screen', 'window', 'panel'] as const) {
      const { container, unmount } = setup(stateOf(), variant);
      expect(container.querySelector(`.ct-focus--${variant}`)).not.toBeNull();
      unmount();
    }
    vi.restoreAllMocks();
  });
});

describe('Pause et reprise à l’écran (F-02)', () => {
  const pausedState = (pausedAt = '2026-10-04T08:09:26.000Z'): FocusWindowState => stateOf({ pausedAt }, { phase: 'paused' });

  it('critères 1 et 9 : « Pause » (nom accessible « Mettre en pause ») envoie l’ordre', () => {
    const { actions } = setup(stateOf());
    const button = screen.getByRole('button', { name: 'Mettre en pause' });
    expect(button).toHaveTextContent('Pause');
    fireEvent.click(button);
    expect(actions).toEqual([{ type: 'pause' }]);
  });

  it('critères 1 et 9 : en pause, « Reprendre », temps figé, « En pause depuis 00:12 », anneau grisé, état annoncé', () => {
    const { container, advance } = setup(pausedState(), 'screen', Date.parse(START) + 9 * MIN + 38_000);
    expect(screen.getByRole('timer')).toHaveTextContent('15:34');
    expect(screen.getByText('En pause depuis 00:12')).toBeInTheDocument();
    const resume = screen.getByRole('button', { name: 'Reprendre la session' });
    expect(resume).toHaveTextContent('Reprendre');
    expect(screen.getByRole('region', { name: 'Session Focus' })).toHaveClass('ct-focus--paused');
    expect(container.querySelector('.ct-focus__arc')).toHaveAttribute('stroke', 'var(--ct-focus-arc-paused)');
    expect(container.querySelector('[aria-live="polite"]')).toBeInTheDocument();
    expect(screen.getByText('Session en pause')).toBeInTheDocument();
    advance(30 * MIN);
    // Le temps reste figé, la mention continue de compter la pause (par horodatage).
    expect(screen.getByRole('timer')).toHaveTextContent('15:34');
    expect(screen.getByText('En pause depuis 30:12')).toBeInTheDocument();
    fireEvent.click(resume);
  });

  it('critère 4 : au redémarrage l’état « En pause » est restauré tel quel', () => {
    setup(pausedState('2026-10-04T08:09:26.000Z'), 'screen', Date.parse(START) + 5 * 3_600_000 + 9 * MIN + 26_000);
    expect(screen.getByRole('timer')).toHaveTextContent('15:34');
    expect(screen.getByRole('button', { name: 'Reprendre la session' })).toBeInTheDocument();
  });

  it('critère 6 : la barre d’espace bascule pause / reprise dans la mini-fenêtre, et seulement là', () => {
    const { actions, rerender, clock } = setup(stateOf(), 'window');
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(actions).toEqual([{ type: 'pause' }]);
    rerender(<FocusView state={pausedState()} variant="window" clock={clock} onAction={(a) => actions.push(a)} />);
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(actions).toEqual([{ type: 'pause' }, { type: 'resume' }]);
    // Sur un bouton, l’espace garde son rôle natif (pas de double bascule) ; les autres variantes ne l’écoutent pas.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reprendre la session' }), { key: ' ' });
    expect(actions).toHaveLength(2);
    cleanup();
    const other = setup(stateOf(), 'screen');
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(other.actions).toEqual([]);
  });

  it('critère 7 : après 2 h de pause, « Toujours en pause ? » avec Reprendre et Arrêter', () => {
    const { actions } = setup(pausedState(), 'screen', Date.parse(START) + 9 * MIN + 26_000 + 2 * 3_600_000 + 1000);
    const group = screen.getByRole('group', { name: 'Toujours en pause ?' });
    fireEvent.click(within(group).getByRole('button', { name: 'Reprendre' }));
    expect(actions).toEqual([{ type: 'resume' }]);
    fireEvent.click(within(group).getByRole('button', { name: 'Arrêter' }));
    expect(screen.getByRole('alertdialog', { name: 'Arrêter la session ?' })).toBeInTheDocument();
  });

  it('critère 7 : sous 2 h de pause, la question n’est pas posée', () => {
    setup(pausedState(), 'screen', Date.parse(START) + 9 * MIN + 26_000 + 3_600_000);
    expect(screen.queryByRole('group', { name: 'Toujours en pause ?' })).not.toBeInTheDocument();
  });

  it('critère 5 : arrêter en pause envoie l’arrêt avec le temps actif seul (9 min)', () => {
    const { actions } = setup(pausedState(), 'screen', Date.parse(START) + 40 * MIN);
    fireEvent.click(screen.getByRole('button', { name: 'Fermer Focus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Arrêter et enregistrer 9 min' }));
    expect(actions).toEqual([{ type: 'stop' }]);
  });

  it('un terme atteint n’est pas signalé pendant une pause', () => {
    const { actions } = setup(pausedState('2026-10-04T08:09:26.000Z'), 'window', Date.parse(START) + 3 * 3_600_000);
    expect(actions.filter((a) => a.type === 'elapsed')).toEqual([]);
  });
});
