import { useLayoutEffect, useRef } from 'react';
import type { SidebarAnchor } from '@/lib/layout/sidebarStore';

interface UseImperativeSlideOptions {
  ref: React.RefObject<HTMLElement | null>;
  isOpen: boolean;
  anchor: SidebarAnchor;
  durationMs?: number;
  /** Skip the animation entirely and snap straight to the target position.
   *  Driven by prefers-reduced-motion / an app accessibility setting. */
  reduceMotion?: boolean;
}

const OFFSET_PROPERTY: Record<SidebarAnchor, 'right' | 'left' | 'bottom'> = {
  right: 'right',
  left: 'left',
  bottom: 'bottom',
};

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * rAF-writes the box-offset (`right`/`left`/`bottom`) — never transform or CSS transition
 * (both raced on WebKitGTK). The same property animates and rests: nothing to switch or
 * race. The per-frame layout cost is deliberate — not the #45 category of risk.
 */
export function useImperativeSlide({
  ref,
  isOpen,
  anchor,
  durationMs = 200,
  reduceMotion = false,
}: UseImperativeSlideOptions) {
  const rafRef = useRef<number | null>(null);
  const currentValueRef = useRef<number | null>(null); // null = not yet initialized
  const lastAnchorRef = useRef<SidebarAnchor | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // #101 — the anchor changed → the previous dock's offset is stale;
    // clear it and force the re-init below.
    if (lastAnchorRef.current !== null && lastAnchorRef.current !== anchor) {
      el.style.setProperty(OFFSET_PROPERTY[lastAnchorRef.current], '');
      currentValueRef.current = null;
    }
    lastAnchorRef.current = anchor;

    const property = OFFSET_PROPERTY[anchor];
    const size = anchor === 'bottom' ? el.offsetHeight : el.offsetWidth;
    const hiddenValue = -size;
    const write = (value: number) => {
      el.style.setProperty(property, `${value}px`);
    };

    if (currentValueRef.current === null) {
      currentValueRef.current = isOpen ? 0 : hiddenValue;
      write(currentValueRef.current);
    }

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const from = currentValueRef.current;
    const to = isOpen ? 0 : hiddenValue;
    const distance = to - from;

    if (distance === 0) return;

    if (reduceMotion) {
      currentValueRef.current = to;
      write(to);
      return;
    }

    const start = performance.now();

    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(elapsed / durationMs, 1);
      const eased = easeOutCubic(t);
      const value = from + distance * eased;
      currentValueRef.current = value;
      write(value);

      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        currentValueRef.current = to;
        write(to);
        rafRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // The anchor rides the deps: a redock re-runs this effect (the
    // stale-offset cleanup above re-inits the value for the new dock).
  }, [isOpen, anchor, reduceMotion, durationMs, ref]);
}
