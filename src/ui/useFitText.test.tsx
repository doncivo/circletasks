import { render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIT_TEXT_MIN_PX, useFitText } from './useFitText';

/**
 * useFitText (IOS-titres) : jsdom n'a pas de mise en page ; largeurs simulées : le texte mesure `textEmWidth` em à la taille
 * courante, la place est `room` px. La vraie mise en page est vérifiée par tests/e2e/IOS-titres.spec.ts (Chromium et WebKit).
 */
let room = 0;
let textEmWidth = 0;
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
      const size = fontSizeOf(this);
      return Math.ceil(textEmWidth * size * (1 + (52 - size) / 1000));
    },
  });
});

afterEach(() => {
  if (descriptors.clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', descriptors.clientWidth);
  if (descriptors.scrollWidth) Object.defineProperty(Element.prototype, 'scrollWidth', descriptors.scrollWidth);
  document.head.innerHTML = '';
});

function Title({ text }: { text: string }) {
  const row = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useFitText(title, row, text);
  return (
    <div ref={row}>
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

  it('place minuscule : plancher lisible', () => {
    withCssSize(52);
    room = 10;
    textEmWidth = 3;
    const { getByRole } = render(<Title text="30 mer." />);
    expect(parseFloat(getByRole('heading').style.fontSize)).toBe(FIT_TEXT_MIN_PX);
  });
});
