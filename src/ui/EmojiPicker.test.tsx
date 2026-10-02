import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmojiPicker } from './EmojiPicker';

describe('EmojiPicker (T-03)', () => {
  it('expose un groupe nommé et une pastille par emoji du catalogue', () => {
    render(<EmojiPicker value={null} onChange={() => undefined} />);
    expect(screen.getByRole('group', { name: 'Choisir un emoji' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Emoji téléphone' })).toBeInTheDocument();
  });

  it('marque l’emoji choisi, critère 2', () => {
    render(<EmojiPicker value={{ kind: 'emoji', value: '📞' }} onChange={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Emoji téléphone, choisie' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('choisir un emoji remplace toute icône Lucide (un seul champ icon, critère 2)', () => {
    const onChange = vi.fn();
    render(<EmojiPicker value={{ kind: 'lucide', name: 'phone' }} onChange={onChange} />);
    screen.getByRole('button', { name: 'Emoji téléphone' }).click();
    expect(onChange).toHaveBeenCalledWith({ kind: 'emoji', value: '📞' });
  });

  it('un second toucher désélectionne l’emoji choisi', () => {
    const onChange = vi.fn();
    render(<EmojiPicker value={{ kind: 'emoji', value: '📞' }} onChange={onChange} />);
    screen.getByRole('button', { name: 'Emoji téléphone, choisie' }).click();
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('accepte un emoji saisi dans le champ libre (sous-tâche 5)', () => {
    const onChange = vi.fn();
    render(<EmojiPicker value={null} onChange={onChange} />);
    const field = screen.getByRole('textbox', { name: 'Autre emoji' });
    fireEvent.change(field, { target: { value: '🥛' } });
    expect(onChange).toHaveBeenCalledWith({ kind: 'emoji', value: '🥛' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('signale un champ libre invalide (plus d’un graphème) sans appeler onChange', () => {
    const onChange = vi.fn();
    render(<EmojiPicker value={null} onChange={onChange} />);
    const field = screen.getByRole('textbox', { name: 'Autre emoji' });
    fireEvent.change(field, { target: { value: '🥛📞' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Un seul emoji à la fois.');
  });
});
