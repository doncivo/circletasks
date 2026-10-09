import { render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentWidth, FIT_FLOOR_ATTRIBUTE, FIT_TEXT_MIN_PX, useFitText } from './useFitText';

/**
 * useFitText (IOS-titres) : jsdom n'a pas de mise en page ; largeurs simulées : le texte mesure `textEmWidth` em à la taille
 * courante, la place est `room` px. La vraie mise en page est vérifiée par tests/e2e/IOS-titres.spec.ts (Chromium et WebKit).
 */
let room = 0;
let textEmWidth = 0;
/** Lectures de scrollWidth : chaque ajustement en fait au moins une. */
let measures = 0;
const descriptors = {
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  scrollWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth'),
};

function fontSizeOf(element: Element): number {
  return parseFloat(getComputedStyle(element).fontSize);
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => room });
  Object.defineProperty(Element.prototype, 'scrollWidth', {
    configurable: true,
    get(this: Element) {
      // Chasse légèrement plus large aux petites tailles (taille optique) : la première estimation ne suffit pas toujours.
      measures += 1;
      const size = fontSizeOf(this);
      const width = Math.ceil(textEmWidth * size * (1 + (52 - size) / 1000));
      // Passage à la ligne entre deux mots : le texte tient dans la place.
      return (this as HTMLElement).style.whiteSpace === 'normal' ? Math.min(width, room) : width;
    },
  });
});

afterEach(() => {
  if (descriptors.clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', descriptors.clientWidth);
  if (descriptors.scrollWidth) Object.defineProperty(Element.prototype, 'scrollWidth', descriptors.scrollWidth);
  document.head.innerHTML = '';
});

function Title({ text, rowClass }: { text: string; rowClass?: string }) {
  const row = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useFitText(title, row, text);
  return (
    <div ref={row} className={rowClass}>
      <h1 ref={title} className="fit-title">
        {text}
      </h1>
    </div>
  );
}

function withCssSize(px: number): void {
  const style = document.createElement('style');
  style.textContent = `.fit-title { font-size: ${String(px)}px; }`;
  document.head.appendChild(style);
}

describe('useFitText', () => {
  it('le texte tient : taille de la maquette inchangée (aucun style posé)', () => {
    withCssSize(52);
    room = 300;
    textEmWidth = 3;
    const { getByRole } = render(<Title text="9 ven." />);
    expect(getByRole('heading').style.fontSize).toBe('');
  });

  it('le texte dépasse : taille réduite jusqu’à tenir dans la place, jamais au-dessus de la maquette', () => {
    withCssSize(40);
    room = 248;
    textEmWidth = 7.3;
    const { getByRole } = render(<Title text="28 sept. – 4 oct." />);
    const heading = getByRole('heading');
    const size = parseFloat(heading.style.fontSize);
    expect(size).toBeLessThan(40);
    expect(heading.scrollWidth).toBeLessThanOrEqual(room);
  });

  it('un nouveau texte plus court rend la taille de la maquette', () => {
    withCssSize(40);
    room = 248;
    textEmWidth = 7.3;
    const { getByRole, rerender } = render(<Title text="28 sept. – 4 oct." />);
    expect(getByRole('heading').style.fontSize).not.toBe('');
    textEmWidth = 4.6;
    rerender(<Title text="5 – 11 oct." />);
    expect(getByRole('heading').style.fontSize).toBe('');
  });

  it('place minuscule (texte très agrandi) : plancher lisible, puis passage à la ligne entre les mots, jamais de chevauchement', () => {
    withCssSize(52);
    room = 10;
    textEmWidth = 3;
    const { getByRole } = render(<Title text="30 mer." />);
    const heading = getByRole('heading');
    expect(parseFloat(heading.style.fontSize)).toBe(FIT_TEXT_MIN_PX);
    expect(heading.style.whiteSpace).toBe('normal');
    expect(heading.getAttribute(FIT_FLOOR_ATTRIBUTE)).toBe('floor');
    expect(heading.scrollWidth).toBeLessThanOrEqual(room);
  });

  it('place retrouvée : le passage à la ligne est retiré', () => {
    withCssSize(52);
    room = 10;
    textEmWidth = 3;
    const { getByRole, rerender } = render(<Title text="30 mer." />);
    expect(getByRole('heading').style.whiteSpace).toBe('normal');
    room = 300;
    rerender(<Title text="9 ven." />);
    expect(getByRole('heading').style.whiteSpace).toBe('');
    expect(getByRole('heading').style.fontSize).toBe('');
    expect(getByRole('heading').hasAttribute(FIT_FLOOR_ATTRIBUTE)).toBe(false);
  });

  it('rangée observée : ajusté seulement quand sa LARGEUR change (pas sa hauteur)', () => {
    const callbacks: ResizeObserverCallback[] = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    // Rangée : boîte de 376 px, 20 px de marge intérieure de chaque côté → contenu de 336 px (même mesure que l'événement resize).
    let box = { width: 376, height: 42 };
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => box as DOMRect);
    const style = document.createElement('style');
    style.textContent = '.fit-row { padding: 0 20px; }';
    document.head.appendChild(style);
    try {
      withCssSize(40);
      room = 248;
      textEmWidth = 7.3;
      render(<Title text="28 sept. – 4 oct." rowClass="fit-row" />);
      const notify = (width: number, height: number): void => {
        box = { width, height };
        // contentRect volontairement faux : le hook lit la largeur de contenu lui-même (une seule mesure).
        for (const callback of callbacks) callback([{ contentRect: { width: 0, height: 0 } } as ResizeObserverEntry], {} as ResizeObserver);
      };
      notify(376, 42);
      const afterFirst = measures;
      expect(afterFirst).toBeGreaterThan(0);
      notify(376, 60);
      expect(measures).toBe(afterFirst);
      // Même largeur de contenu signalée par l'événement resize : aucun nouvel ajustement.
      window.dispatchEvent(new Event('resize'));
      expect(measures).toBe(afterFirst);
      notify(311, 60);
      expect(measures).toBeGreaterThan(afterFirst);
    } finally {
      rect.mockRestore();
      globalThis.ResizeObserver = original;
    }
  });

  it('événement resize de la fenêtre : ajusté si la largeur de la rangée a changé, sans attendre ResizeObserver ; écoute retirée au démontage', () => {
    withCssSize(40);
    room = 248;
    textEmWidth = 7.3;
    let rowWidth = 336;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: rowWidth }) as DOMRect);
    try {
      const { unmount } = render(<Title text="28 sept. – 4 oct." />);
      window.dispatchEvent(new Event('resize'));
      const afterFirst = measures;
      window.dispatchEvent(new Event('resize'));
      expect(measures).toBe(afterFirst);
      rowWidth = 326;
      window.dispatchEvent(new Event('resize'));
      expect(measures).toBeGreaterThan(afterFirst);
      unmount();
      const afterUnmount = measures;
      rowWidth = 271;
      window.dispatchEvent(new Event('resize'));
      expect(measures).toBe(afterUnmount);
    } finally {
      rect.mockRestore();
    }
  });

  it('polices chargées après coup (loadingdone) : nouvel ajustement ; écoute retirée au démontage', () => {
    const target = new EventTarget();
    const fonts = Object.assign(target, { ready: new Promise<never>(() => undefined) });
    const descriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    try {
      withCssSize(40);
      room = 248;
      textEmWidth = 7.3;
      const { unmount } = render(<Title text="28 sept. – 4 oct." />);
      const before = measures;
      target.dispatchEvent(new Event('loadingdone'));
      expect(measures).toBeGreaterThan(before);
      unmount();
      const afterUnmount = measures;
      target.dispatchEvent(new Event('loadingdone'));
      expect(measures).toBe(afterUnmount);
    } finally {
      if (descriptor) Object.defineProperty(document, 'fonts', descriptor);
      else Reflect.deleteProperty(document, 'fonts');
    }
  });
});

describe('contentWidth', () => {
  it('largeur de contenu : boîte moins bordures et marges intérieures, fractions gardées', () => {
    const style = document.createElement('style');
    style.textContent = '.measured { padding: 0 20.5px 0 19.5px; border-left: 1px solid; border-right: 2px solid; }';
    document.head.appendChild(style);
    const element = document.createElement('div');
    element.className = 'measured';
    document.body.appendChild(element);
    const rect = vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ width: 379.25 } as DOMRect);
    try {
      expect(contentWidth(element)).toBeCloseTo(336.25, 5);
    } finally {
      rect.mockRestore();
      element.remove();
    }
  });
});
