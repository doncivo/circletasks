import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSaveFailure } from './FileSaveFailure';

/** Revue du lot F : un échec qu'un nouvel essai ne peut pas résoudre n'a pas de « Réessayer », mais un texte avec l'action utile. */
describe('FileSaveFailure', () => {
  afterEach(() => cleanup());

  it('io : message, code et « Réessayer »', () => {
    render(<FileSaveFailure message="L’export n’a pas abouti." code="io" onRetry={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Code : io');
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
  });

  it.each([
    ['too-large', /Réduisez le contenu exporté/],
    ['unsafe-folder', /fermez puis rouvrez CircleTasks/],
    ['bad-name', /exportez les logs/],
  ])('%s : action utile, aucun « Réessayer »', (code, text) => {
    render(<FileSaveFailure message="L’export n’a pas abouti." code={code} onRetry={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(text);
    expect(screen.getByRole('alert')).toHaveTextContent(`Code : ${code}`);
    expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
  });
});
