import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { MathfieldElement } from 'mathlive';
import { loadMathLive } from '@/lib/equations/wysiwyg';

/**
 * M-EQ-2 — the WYSIWYG math field: a thin React wrapper over
 * MathLive's <math-field> custom element.
 *
 * OWNERSHIP: the field is the EDITING surface — its `input` event is
 * the one latex producer (draft state in the bubble); `onChange` is
 * the bubble's live-apply. The `latex` prop flows back only when it
 * changes OUTSIDE the field (the Source textarea path, undo): the
 * setValue is echo-guarded by the last-emitted ref so the field never
 * fights its own input events.
 *
 * THE FALLBACK LAW: MathLive needs real layout (ResizeObserver,
 * custom-element upgrade, webfonts) — none of which jsdom has. The
 * loader is lazy; on failure (tests, exotic webviews) this component
 * calls `onUnavailable()` ONCE and renders nothing — the bubble swaps
 * to its Source textarea as the editing surface. Graceful, never a
 * crash (the broken-glyph law's editor arm).
 *
 * PALETTE INSERTS ride `executeCommand(['insert', latex])` — the
 * structural forms carry `#@` (the current selection) and `#?`
 * (placeholder the caret lands in): clicking "Fraction" puts the
 * caret INSIDE the new fraction's empty slot. Exposed via the ref
 * handle.
 */

export interface MathLiveFieldHandle {
  insert(latex: string): void;
  focus(): void;
}

interface MathLiveFieldProps {
  latex: string;
  onChange: (latex: string) => void;
  onUnavailable: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export const MathLiveField = forwardRef<MathLiveFieldHandle, MathLiveFieldProps>(
  function MathLiveField({ latex, onChange, onUnavailable, className, style }, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mfRef = useRef<MathfieldElement | null>(null);
  const lastEmittedRef = useRef<string>(latex);
  const unavailableRef = useRef(false);
  // The latest callbacks, read by the MOUNT-time listeners through
  // refs — the field mounts once per bubble open, but the callbacks'
  // closures stay fresh (the exhaustive-deps law, honored not silenced).
  const onChangeRef = useRef(onChange);
  const onUnavailableRef = useRef(onUnavailable);
  const latexRef = useRef(latex);
  onChangeRef.current = onChange;
  onUnavailableRef.current = onUnavailable;
  latexRef.current = latex;
  const [, forceReady] = useState(0);

  // The imperative palette insert: the structural forms carry `#@`/
  // `#?` — selection into slot 1, caret into the placeholder slot.
  useImperativeHandle(ref, () => ({
    insert(latexToInsert: string) {
      const mf = mfRef.current;
      if (!mf) return;
      mf.executeCommand(['insert', latexToInsert]);
      mf.focus();
    },
    focus() {
      mfRef.current?.focus();
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    void loadMathLive()
      .then(() => {
        if (cancelled || !hostRef.current) return;
        const mf = document.createElement('math-field') as MathfieldElement;
        // The keyboard overlays and alternate-key popovers are chrome
        // noise for a desktop editor; the structural work happens
        // through typing + the palette.
        mf.menuItems = [];
        mf.smartMode = true;
        mf.smartFence = true;
        mf.smartSuperscript = true;
        hostRef.current.appendChild(mf);
        mfRef.current = mf;
        mf.value = latexRef.current;
        mf.addEventListener('input', () => {
          const next = mf.getValue('latex');
          lastEmittedRef.current = next;
          onChangeRef.current(next);
        });
        // The field is the primary surface — it takes the caret on
        // mount (rAF: the element needs one layout pass post-upgrade).
        requestAnimationFrame(() => mf.focus());
        forceReady((v) => v + 1);
      })
      .catch((err) => {
        if (cancelled || unavailableRef.current) return;
        unavailableRef.current = true;
        if (import.meta.env.DEV) {
          console.info('[equations] MathLive unavailable — falling back to source editing', err);
        }
        onUnavailableRef.current();
      });
    return () => {
      cancelled = true;
      if (mfRef.current) {
        mfRef.current.remove();
        mfRef.current = null;
      }
    };
    // The field mounts once per bubble open; latex and the callbacks
    // flow through refs (below) — a stable deps array is the honest
    // spelling, no disable directive needed.
  }, []);

  // EXTERNAL latex changes (the Source textarea, undo): push into the
  // field unless the field itself is the origin (the echo guard).
  useEffect(() => {
    const mf = mfRef.current;
    if (!mf) return;
    if (latex === lastEmittedRef.current) return;
    lastEmittedRef.current = latex;
    mf.value = latex;
  }, [latex]);

  return <div ref={hostRef} className={className} style={style} data-mathlive-field="true" />;
  },
);

export default MathLiveField;