import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from './Switch';

describe('Switch', () => {
  it('reflète l’état via aria-checked', () => {
    render(<Switch checked={true} onChange={() => undefined} label="Reporter les tâches non faites" />);
    expect(screen.getByRole('switch', { name: 'Reporter les tâches non faites', checked: true })).toBeInTheDocument();
  });

  it('appelle onChange avec l’état inverse', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Option" />);
    screen.getByRole('switch', { name: 'Option' }).click();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('désactivé : aucun appel', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Option" disabled />);
    screen.getByRole('switch', { name: 'Option' }).click();
    expect(onChange).not.toHaveBeenCalled();
  });
});
