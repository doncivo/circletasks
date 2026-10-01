import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox';

describe('Checkbox', () => {
  it('reflète l’état coché via aria-checked', () => {
    render(<Checkbox checked={true} onChange={() => undefined} label="Terminer : Boire de l'eau" />);
    expect(screen.getByRole('checkbox', { name: "Terminer : Boire de l'eau" })).toHaveAttribute('aria-checked', 'true');
  });

  it('appelle onChange avec l’état inverse au clic', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Terminer : Sport" />);
    screen.getByRole('checkbox').click();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('respecte la zone tactile minimale de 44 px', () => {
    render(<Checkbox checked={false} onChange={() => undefined} label="Terminer : Sport" />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox.style.minWidth).toBe('var(--ct-hit-target-min)');
    expect(checkbox.style.minHeight).toBe('var(--ct-hit-target-min)');
  });
});
