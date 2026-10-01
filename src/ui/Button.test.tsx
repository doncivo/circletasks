import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

const SAVE = 'Enregistrer';
const POSTPONE = 'Reporter';

describe('Button', () => {
  it('rend le libellé fourni par l’appelant', () => {
    render(<Button onClick={() => undefined}>{SAVE}</Button>);
    expect(screen.getByRole('button', { name: SAVE })).toBeInTheDocument();
  });

  it('appelle onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>{SAVE}</Button>);
    screen.getByRole('button').click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('se désactive et n’appelle plus onClick', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        {SAVE}
      </Button>,
    );
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    button.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('applique la variante secondaire', () => {
    render(<Button variant="secondary">{POSTPONE}</Button>);
    expect(screen.getByRole('button')).toHaveClass('ct-button--secondary');
  });
});
