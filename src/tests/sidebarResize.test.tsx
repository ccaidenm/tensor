import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { SidebarHost } from '@/lib/layout/sidebar/SidebarHost';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { useConfigStore } from '@/lib/config/store';
import { zoneForPointer } from '@/lib/layout/sidebar/SidebarHost';

/**
 * #101 — draggable sidebars: the dock-edge resize handle — the drag
 * math (directional per anchor), the clamps, the width memory (per
 * sidebar, committed on release), and the double-click reset.
 *
 * The slides are irrelevant here (the imperative slide snaps with the
 * project-wide animation disable); the assertions ride the inline
 * width style + the config commits.
 */

beforeEach(() => {
  useSidebarStore.setState({ active: null });
  useConfigStore.setState({
    config: { ...useConfigStore.getState().config, sidebarWidths: {} },
  });
});

function openPanel(id = 'statistics') {
  act(() => {
    useSidebarStore.getState().open(id, 'right');
  });
}

function drag(handle: HTMLElement, startClientX: number, endClientX: number) {
  fireEvent.pointerDown(handle, { button: 0, clientX: startClientX, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: endClientX, pointerId: 1 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
}

describe('draggable sidebars (#101)', () => {
  it('the handle renders on the dock edge while open (and only while open)', () => {
    const { rerender } = render(
      <div className="relative">
        <SidebarHost id="statistics" anchor="right">
          <div>panel</div>
        </SidebarHost>
      </div>,
    );
    expect(document.querySelector('[data-testid="sidebar-resize-statistics"]')).toBeNull();
    openPanel();
    rerender(
      <div className="relative">
        <SidebarHost id="statistics" anchor="right">
          <div>panel</div>
        </SidebarHost>
      </div>,
    );
    expect(document.querySelector('[data-testid="sidebar-resize-statistics"]')).not.toBeNull();
  });

  it('dragging the handle left WIDENS a right-anchored panel, live and committed', () => {
    openPanel();
    const { container } = render(
      <div className="relative">
        <SidebarHost id="statistics" anchor="right">
          <div>panel</div>
        </SidebarHost>
      </div>,
    );
    const handle = container.querySelector('[data-testid="sidebar-resize-statistics"]') as HTMLElement;
    drag(handle, 800, 720); // 80px leftward = +80 width
    // The committed width: 384 (default) + 80 = 464.
    expect(useConfigStore.getState().config.sidebarWidths.statistics).toBe(464);
  });

  it('the clamp holds: the drag never leaves [280, 640]', () => {
    openPanel();
    const { container } = render(
      <div className="relative">
        <SidebarHost id="statistics" anchor="right">
          <div>panel</div>
        </SidebarHost>
      </div>,
    );
    const handle = container.querySelector('[data-testid="sidebar-resize-statistics"]') as HTMLElement;
    drag(handle, 800, -500); // a huge widening drag
    expect(useConfigStore.getState().config.sidebarWidths.statistics).toBe(640);
    drag(handle, 0, 2000); // a huge narrowing drag
    expect(useConfigStore.getState().config.sidebarWidths.statistics).toBe(280);
  });

  it('the width memory is per-sidebar and survives a close/reopen', () => {
    useConfigStore.setState({
      config: { ...useConfigStore.getState().config, sidebarWidths: { statistics: 500 } },
    });
    openPanel('statistics');
    const { container, rerender } = render(
      <div className="relative">
        <SidebarHost id="statistics" anchor="right">
          <div>panel</div>
        </SidebarHost>
      </div>,
    );
    const panel = container.querySelector('[data-testid="sidebar-resize-statistics"]')!.parentElement as HTMLElement;
    expect(panel.style.width).toBe('500px');
    // Close and reopen — the memory rides.
    act(() => {
      useSidebarStore.getState().close();
    });
    rerender(
      <div className="relative">
        <SidebarHost id="statistics" anchor="right">
          <div>panel</div>
        </SidebarHost>
      </div>,
    );
    act(() => {
      useSidebarStore.getState().open('statistics', 'right');
    });
    rerender(
      <div className="relative">
        <SidebarHost id="statistics" anchor="right">
          <div>panel</div>
        </SidebarHost>
      </div>,
    );
    const panel2 = container.querySelector('[data-testid="sidebar-resize-statistics"]')!.parentElement as HTMLElement;
    expect(panel2.style.width).toBe('500px');
  });

  it('double-click resets to the default width (Word posture)', () => {
    useConfigStore.setState({
      config: { ...useConfigStore.getState().config, sidebarWidths: { statistics: 600 } },
    });
    openPanel();
    const { container } = render(
      <div className="relative">
        <SidebarHost id="statistics" anchor="right">
          <div>panel</div>
        </SidebarHost>
      </div>,
    );
    const handle = container.querySelector('[data-testid="sidebar-resize-statistics"]') as HTMLElement;
    fireEvent.dblClick(handle);
    expect(useConfigStore.getState().config.sidebarWidths.statistics).toBe(384);
  });

  it('the handle is a separator with an accessible name (keyboard/a11y surface)', () => {
    openPanel();
    const { container } = render(
      <div className="relative">
        <SidebarHost id="statistics" anchor="right">
          <div>panel</div>
        </SidebarHost>
      </div>,
    );
    const handle = container.querySelector('[role="separator"][aria-label="Resize statistics panel"]') as HTMLElement;
    expect(handle).not.toBeNull();
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
  });
});

describe('drag-to-redock (#101)', () => {
  it('the grip strip renders on open panels (host chrome, every panel)', () => {
    openPanel();
    const { container } = render(
      <div className="relative">
        <SidebarHost id="statistics" anchor="right">
          <div>panel</div>
        </SidebarHost>
      </div>,
    );
    expect(container.querySelector('[data-testid="sidebar-grip-statistics"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Move statistics panel"]')).not.toBeNull();
  });

  it('REDOCK by store: the panel renders on the NEW anchor (the position classes swap)', () => {
    openPanel('search');
    const { container, rerender } = render(
      <div className="relative">
        <SidebarHost id="search" anchor="right">
          <div>panel</div>
        </SidebarHost>
      </div>,
    );
    // Right-docked: the left-edge resize handle.
    expect(container.querySelector('.border-l')).not.toBeNull();
    act(() => {
      useSidebarStore.getState().dock('search', 'left');
    });
    rerender(
      <div className="relative">
        <SidebarHost id="search" anchor="left">
          <div>panel</div>
        </SidebarHost>
      </div>,
    );
    // Left-docked: the RIGHT-edge handle + the border side swapped.
    expect(container.querySelector('.border-r')).not.toBeNull();
    const handle = container.querySelector('[data-testid="sidebar-resize-search"]') as HTMLElement;
    expect(handle.className).toContain('right-0');
  });

  it('the anchor memory survives close/reopen (the store records the redock)', () => {
    openPanel('search');
    render(
      <div className="relative">
        <SidebarHost id="search" anchor="right">
          <div>panel</div>
        </SidebarHost>
      </div>,
    );
    act(() => {
      useSidebarStore.getState().dock('search', 'bottom');
    });
    act(() => {
      useSidebarStore.getState().close();
    });
    // Reopen via open() — the anchor memory still routes it bottom.
    act(() => {
      useSidebarStore.getState().open('search', 'right');
    });
    expect(useSidebarStore.getState().anchors.search).toBe('bottom');
  });

  it('THE ZONE LAW: bottom wins the corner overlap; edges claim their bands; no zone away from edges', () => {
    const desk = { left: 0, top: 0, width: 1200, height: 800 };
    expect(zoneForPointer(10, 780, desk)).toBe('bottom'); // the corner: bottom wins
    expect(zoneForPointer(10, 400, desk)).toBe('left');
    expect(zoneForPointer(1190, 400, desk)).toBe('right');
    expect(zoneForPointer(600, 790, desk)).toBe('bottom');
    expect(zoneForPointer(600, 400, desk)).toBeNull(); // mid-desk
    // A zero rect (jsdom's getBoundingClientRect) yields null — the
    // grip's release keeps the panel where it came from.
    expect(zoneForPointer(10, 780, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });

  it('the grip drag floats the panel (fixed, pointer-following) and release docks to the zone', async () => {
    openPanel();
    const { container } = render(
      <div className="relative">
        <SidebarHost id="statistics" anchor="right">
          <div>panel</div>
        </SidebarHost>
      </div>,
    );
    const grip = container.querySelector('[data-testid="sidebar-grip-statistics"]') as HTMLElement;
    // Down + move: the panel floats (position fixed).
    fireEvent.pointerDown(grip, { button: 0, clientX: 1000, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 500, clientY: 300, pointerId: 1 });
    const panel = container.querySelector('.fixed') as HTMLElement;
    expect(panel).not.toBeNull();
    // The float's position rides the Tailwind class (the compiled CSS
    // applies it in the real app; jsdom asserts the class contract).
    expect(panel.className.split(' ')).toContain('fixed');
    // The release: the zone math (jsdom rects read 0 → no zone → snap
    // back to the original anchor — the store keeps the panel right).
    fireEvent.pointerUp(grip, { clientX: 500, clientY: 300, pointerId: 1 });
    expect(useSidebarStore.getState().active?.anchor).toBe('right');
    // And the docked panel is back (no floating element remains).
    expect(container.querySelector('.fixed')).toBeNull();
  });
});
