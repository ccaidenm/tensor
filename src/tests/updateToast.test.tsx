import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Toaster, toast } from '@/components/ui/toast';

/**
 * The update notification's action button: toast.add's actionProps
 * must reach the rendered Action — the "View release" button is how
 * a user reaches the release page.
 */
describe('the update toast action', () => {
  it('renders the actionProps button and fires its onClick', async () => {
    const onClick = vi.fn();
    render(
      <Toaster>
        <div />
      </Toaster>,
    );
    toast.add({
      title: 'Tensor 0.2.0 is available',
      description: 'Download it from the releases page on GitHub.',
      type: 'info',
      actionProps: { children: 'View release', onClick },
    });
    const button = await screen.findByRole('button', { name: 'View release' });
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
