import { useLayoutEffect, useState, type CSSProperties } from 'react';
import { Sheet, type SheetProps } from '../../ui/Sheet';

/** Le clavier iOS réduit visualViewport, pas nécessairement la fenêtre CSS. */
export function TaskViewportSheet(props: SheetProps) {
  const [frame, setFrame] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const update = (): void => setFrame({ top: viewport.offsetTop, height: viewport.height, bottom: 'auto' });
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);
  return <Sheet {...props} backdropStyle={{ ...frame, paddingTop: 'max(12px, var(--ct-safe-area-top))', background: 'var(--ct-color-surface)' }} />;
}
