import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { asHexColor, asSpaceId } from '../domain/types';
import { SpacePills, type SpacePillItem } from './SpacePills';

const pro: SpacePillItem = { id: asSpaceId('11111111-1111-4111-8111-111111111111'), name: 'Pro', color: asHexColor('#2f6b7a') };
const perso: SpacePillItem = { id: asSpaceId('22222222-2222-4222-8222-222222222222'), name: 'Perso', color: asHexColor('#b5483b') };

describe('SpacePills', () => {
  it('marque la pastille active avec aria-pressed', () => {
    render(<SpacePills items={[pro, perso]} value="all" onChange={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Tout' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Pro' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('appelle onChange avec l’identifiant de l’espace choisi', () => {
    const onChange = vi.fn();
    render(<SpacePills items={[pro, perso]} value="all" onChange={onChange} />);
    screen.getByRole('button', { name: 'Perso' }).click();
    expect(onChange).toHaveBeenCalledWith(perso.id);
  });

  it('appelle onChange avec « all » pour Tout', () => {
    const onChange = vi.fn();
    render(<SpacePills items={[pro, perso]} value={pro.id} onChange={onChange} />);
    screen.getByRole('button', { name: 'Tout' }).click();
    expect(onChange).toHaveBeenCalledWith('all');
  });

  it('expose un groupe nommé', () => {
    render(<SpacePills items={[pro, perso]} value="all" onChange={() => undefined} />);
    expect(screen.getByRole('group', { name: 'Filtre d’espace' })).toBeInTheDocument();
  });
});
