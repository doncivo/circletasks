import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lazyScreen, preloadScreens } from './lazyScreens';

/** Écrans à la demande (PERF-02) : repli neutre, voisin affiché, rendu direct une fois chargé, échec avec « Réessayer », préchargement. */
function Content() {
  return <p>{'Contenu de l’écran'}</p>;
}

describe('écran chargé à la demande', () => {
  afterEach(() => vi.restoreAllMocks());

  it('PC : Aujourd’hui reste affiché à côté de l’écran paresseux ; le repli est vide et masqué aux lecteurs d’écran', async () => {
    let resolve: (value: { default: typeof Content }) => void = () => undefined;
    const Lazy = lazyScreen<object>(() => new Promise((r) => (resolve = r)));
    const { container } = render(
      <>
        <p>{'Aujourd’hui'}</p>
        <Lazy />
      </>,
    );
    expect(screen.getByText('Aujourd’hui')).toBeVisible();
    const placeholder = container.querySelector('.ct-app__placeholder');
    expect(placeholder).not.toBeNull();
    expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    expect(placeholder?.textContent).toBe('');
    resolve({ default: Content });
    expect(await screen.findByText('Contenu de l’écran')).toBeVisible();
    expect(screen.getByText('Aujourd’hui')).toBeVisible();
    expect(container.querySelector('.ct-app__placeholder')).toBeNull();
  });

  it('module déjà arrivé : une nouvelle instance s’affiche aussitôt, sans repli', async () => {
    const load = vi.fn(() => Promise.resolve({ default: Content }));
    const Lazy = lazyScreen<object>(load);
    const first = render(<Lazy />);
    await screen.findByText('Contenu de l’écran');
    first.unmount();
    const { container } = render(<Lazy />);
    // Rendu synchrone : aucun await entre le rendu et la vérification.
    expect(screen.getByText('Contenu de l’écran')).toBeInTheDocument();
    expect(container.querySelector('.ct-app__placeholder')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('bloc illisible : message et « Réessayer » ; le bouton recrée le composant et l’écran apparaît', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    const Lazy = lazyScreen<object>(() => (++calls === 1 ? Promise.reject(new Error('bloc illisible')) : Promise.resolve({ default: Content })));
    render(<Lazy />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible d’afficher cet écran.');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[desktop:screen-load]'));
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText('Contenu de l’écran')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls).toBe(2);
  });
});

describe('écran chargé à la demande : instances et échecs répétés', () => {
  afterEach(() => vi.restoreAllMocks());

  it('deux instances : « Réessayer » sur l’une ne touche pas l’autre', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    const Lazy = lazyScreen<object>(() => (++calls <= 2 ? Promise.reject(new Error('bloc illisible')) : Promise.resolve({ default: Content })));
    render(
      <>
        <section aria-label={'a'}>
          <Lazy />
        </section>
        <section aria-label={'b'}>
          <Lazy />
        </section>
      </>,
    );
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    fireEvent.click(within(screen.getByLabelText('a')).getByRole('button', { name: 'Réessayer' }));
    expect(await within(screen.getByLabelText('a')).findByText('Contenu de l’écran')).toBeInTheDocument();
    expect(within(screen.getByLabelText('b')).getByRole('alert')).toBeInTheDocument();
  });

  it('après un second échec, « Recharger » remplace « Réessayer »', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const Lazy = lazyScreen<object>(() => Promise.reject(new Error('même rejet')));
    render(<Lazy />);
    fireEvent.click(await screen.findByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByRole('button', { name: 'Recharger' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
  });

  it('écran déjà chargé (rendu direct) : une erreur de rendu passe aussi par la frontière', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let broken = false;
    function Fragile() {
      if (broken) throw new Error('rendu cassé');
      return <p>{'Contenu de l’écran'}</p>;
    }
    const Lazy = lazyScreen<object>(() => Promise.resolve({ default: Fragile }));
    const first = render(<Lazy />);
    await screen.findByText('Contenu de l’écran');
    first.unmount();
    broken = true;
    render(<Lazy />);
    expect(screen.getByRole('alert')).toHaveTextContent('Impossible d’afficher cet écran.');
  });
});

describe('préchargement des écrans', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'requestIdleCallback');
    Reflect.deleteProperty(window, 'cancelIdleCallback');
    vi.useRealTimers();
  });

  it('avec requestIdleCallback : un écran par moment d’inactivité, annulable', () => {
    const callbacks: Array<() => void> = [];
    const request = vi.fn((cb: () => void, _options?: { timeout: number }) => callbacks.push(cb));
    const cancel = vi.fn();
    Object.assign(window, { requestIdleCallback: request, cancelIdleCallback: cancel });
    const stop = preloadScreens();
    expect(request).toHaveBeenCalledTimes(1);
    act(() => callbacks[0]?.());
    expect(request).toHaveBeenCalledTimes(2);
    stop();
    expect(cancel).toHaveBeenCalledWith(2);
  });

  it('sans requestIdleCallback (WebKit) : minuteur de 200 ms entre deux écrans, annulable', () => {
    vi.useFakeTimers();
    const stop = preloadScreens();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(200);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('une fois annulé, plus aucun écran n’est planifié', async () => {
    vi.useFakeTimers();
    const stop = preloadScreens();
    stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
