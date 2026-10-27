import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock, type ManualClock } from '../../domain/clock';
import type { FocusWindowAction, FocusWindowState } from '../../platform/focus';
import { setLocale } from '../../i18n';
import { FocusView } from './FocusView';

/**
 * UI-FIX-06 (défaut 13 de la liste d'Ali du 2026-10-27) : l'écran de session s'appelle « Concentration » (titre français, sans capitales),
 * Pause domine visuellement « Terminer la tâche », et le total du jour ne reste plus à zéro pendant la première minute d'une session active.
 */
const START = '2026-10-04T08:00:00.000Z';

function stateOf(rest: Partial<FocusWindowState> = {}, session: Partial<FocusWindowState['session']> = {}): FocusWindowState {
  return {
    phase: 'running',
    session: { id: 's1', plannedMin: 25, startedAt: START, endedAt: null, pausedSec: 0, pausedAt: null, ...session },
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

function setup(state: FocusWindowState, at: number) {
  const clock: ManualClock = createManualClock(at);
  const actions: FocusWindowAction[] = [];
  render(<FocusView state={state} variant="screen" clock={clock} onAction={(a) => actions.push(a)} />);
  const advance = (ms: number): void => {
    clock.advance(ms);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
  };
  return { clock, actions, advance };
}

afterEach(() => {
  cleanup();
  setLocale('fr');
});

describe('UI-FIX-06 : titre « Concentration »', () => {
  it('l’en-tête dit « Concentration », jamais « FOCUS TIME » ; en anglais « Focus »', () => {
    setup(stateOf(), Date.parse(START) + 5_000);
    expect(screen.getByText('Concentration')).toBeInTheDocument();
    expect(screen.queryByText(/FOCUS TIME/i)).toBeNull();
    cleanup();
    setLocale('en');
    setup(stateOf({ locale: 'en' }), Date.parse(START) + 5_000);
    expect(screen.getByText('Focus')).toBeInTheDocument();
  });

  it('la feuille de style n’écrit pas l’en-tête en capitales', () => {
    const css = readFileSync(join(import.meta.dirname, 'FocusView.css'), 'utf8');
    const block = /\.ct-focus__heading\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).not.toMatch(/text-transform:\s*uppercase/);
  });
});

describe('UI-FIX-06 : Pause domine « Terminer la tâche » pendant la session', () => {
  it('en cours : Pause est le bouton plein, Terminer la tâche le bouton au trait', () => {
    setup(stateOf(), Date.parse(START) + 5_000);
    const pause = screen.getByRole('button', { name: 'Mettre en pause' });
    const finish = screen.getByRole('button', { name: 'Terminer la tâche' });
    expect(pause.className).toContain('ct-focus__button--primary');
    expect(finish.className).not.toContain('ct-focus__button--finish');
    expect(finish.className).not.toContain('ct-focus__button--primary');
  });

  it('en pause : Reprendre est le bouton plein, Terminer la tâche reste au trait', () => {
    setup(stateOf({ phase: 'paused' }, { pausedAt: '2026-10-04T08:03:00.000Z' }), Date.parse(START) + 4 * 60_000);
    expect(screen.getByRole('button', { name: 'Reprendre la session' }).className).toContain('ct-focus__button--primary');
    expect(screen.getByRole('button', { name: 'Terminer la tâche' }).className).not.toContain('ct-focus__button--finish');
  });

  it('session terminée : Terminer la tâche redevient l’action principale (inchangé)', () => {
    setup(stateOf({ phase: 'ended', endedMinutes: 25 }, { endedAt: '2026-10-04T08:25:00.000Z' }), Date.parse(START) + 26 * 60_000);
    expect(screen.getByRole('button', { name: 'Terminer la tâche' }).className).toContain('ct-focus__button--finish');
  });

  it('le style plein existe et n’est pas transparent', () => {
    const css = readFileSync(join(import.meta.dirname, 'FocusView.css'), 'utf8');
    const block = /\.ct-focus__button--primary\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).toMatch(/background:\s*var\(--ct-focus-on\)/);
  });
});

describe('UI-FIX-06 : le total du jour suit la session active dès la première seconde', () => {
  it('aucune session terminée, 42 s de session : « Aujourd’hui : 42 s de concentration »', () => {
    setup(stateOf(), Date.parse(START) + 42_000);
    expect(screen.getByText('Aujourd’hui : 42 s de concentration')).toBeInTheDocument();
  });

  it('la minute entamée compte : à 90 s, « Aujourd’hui : 1 min de concentration · session en cours » ; le texte avance avec l’horloge', () => {
    const { advance } = setup(stateOf(), Date.parse(START) + 90_000);
    expect(screen.getByText('Aujourd’hui : 1 min de concentration · session en cours')).toBeInTheDocument();
    advance(60_000);
    expect(screen.getByText('Aujourd’hui : 2 min de concentration · session en cours')).toBeInTheDocument();
  });

  it('avec des sessions terminées, la session active s’ajoute : 25 min · 1 session puis 27 min à 2 min de session', () => {
    setup(stateOf({ today: { minutes: 25, sessions: 1 } }), Date.parse(START) + 2 * 60_000);
    expect(screen.getByText('Aujourd’hui : 27 min de concentration · 1 session · en cours')).toBeInTheDocument();
  });

  it('en pause, le temps de pause ne compte pas : 3 min actives puis pause à 08:03, lu à 08:10 → 3 min', () => {
    setup(stateOf({ phase: 'paused' }, { pausedAt: '2026-10-04T08:03:00.000Z' }), Date.parse(START) + 10 * 60_000);
    expect(screen.getByText('Aujourd’hui : 3 min de concentration · session en cours')).toBeInTheDocument();
  });

  it('à l’instant du lancement : « Aujourd’hui : 0 min de concentration » reste le texte sans aucune seconde active', () => {
    setup(stateOf(), Date.parse(START));
    expect(screen.getByText('Aujourd’hui : 0 min de concentration')).toBeInTheDocument();
  });

  it('session terminée : le pied ne compte que les sessions terminées (le total du jour est relu par la fenêtre)', () => {
    setup(stateOf({ phase: 'ended', endedMinutes: 25, today: { minutes: 25, sessions: 1 } }, { endedAt: '2026-10-04T08:25:00.000Z' }), Date.parse(START) + 26 * 60_000);
    expect(screen.getByText('Aujourd’hui : 25 min de concentration · 1 session')).toBeInTheDocument();
  });
});
