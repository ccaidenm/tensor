import { useEffect, useRef, useState } from 'react';
import { Minimize } from 'lucide-react';
import { IconButton } from '@/components/layout/IconButton';
import { getCommand } from '@/lib/commands/registry';
import { useFocusStore } from '@/lib/layout/focusStore';

/** How long the exit button stays visible after entering Focus Mode
 *  before fading out ("disappears after a few seconds"). */
const EXIT_REVEAL_MS = 3000;
/** The corner hover zone (right × top, px): moving the pointer in here
 *  brings the exit button back after it faded. */
const CORNER_WIDTH = 200;
const CORNER_HEIGHT = 80;

/**
 * FOCUS MODE'S EXIT AFFORDANCE — a floating IconButton, top-right,
 * shown ONLY while Focus Mode is on. Shadcn-native (the ribbon's own
 * IconButton — Button + tooltip with the LIVE kbd hint via shortcutId),
 * carrying the Minimize icon. It reveals on entry, fades after a few
 * seconds, and comes back when the pointer hovers the top-right corner
 * (what the orientation toast tells the user). Clicking it runs the
 * same command body as the ribbon button, the palette, and the shortcut
 * (the registry's law: one body, every surface).
 *
 * Hidden ≠ unmounted: the button stays mounted with opacity-0 +
 * pointer-events-none + aria-hidden so the fade can animate and the
 * corner hover needs no remount — keyboard users always have the
 * (rebindable) shortcut; the a11y tree only ever sees the revealed one.
 */
export function ExitFocusButton() {
  const focusActive = useFocusStore((s) => s.active);
  const [revealed, setRevealed] = useState(false);
  // House timer-ref convention (plain setTimeout: in vitest's jsdom env
  // window.setTimeout is jsdom's own, NOT the fake-timer-patched global
  // — bare setTimeout is what tests can control and what browsers give
  // anyway).
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!focusActive) {
      setRevealed(false);
      return;
    }
    // Entering focus mode: show the way out, then let it fade — the
    // corner hover (below) is the way back.
    setRevealed(true);
    hideTimer.current = setTimeout(() => setRevealed(false), EXIT_REVEAL_MS);
    // Corner tracking via mousemove — NO overlay div (one would swallow
    // the clicks meant for the document beneath it).
    const onMove = (e: MouseEvent) => {
      const inCorner =
        e.clientX > window.innerWidth - CORNER_WIDTH && e.clientY < CORNER_HEIGHT;
      if (inCorner) {
        if (hideTimer.current !== null) {
          clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
        setRevealed(true);
      } else {
        setRevealed(false);
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    };  }, [focusActive]);

  if (!focusActive) return null;

  return (
    <IconButton
      label="Exit focus mode"
      icon={<Minimize size={16} />}
      shortcutId="toggleFocusMode"
      onClick={() => void getCommand('toggleFocusMode')?.run()}
      data-testid="focus-exit-button"
      aria-hidden={!revealed}
      tabIndex={revealed ? 0 : -1}
      // z-[100] — the toast tier, the documented ceiling: the exit must
      // never be covered, but nothing user-facing outranks the law.
      className={`fixed top-2 right-3 z-[100] transition-opacity duration-300 ${
        revealed ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    />
  );
}
