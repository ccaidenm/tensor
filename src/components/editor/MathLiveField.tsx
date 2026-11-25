import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { MathfieldElement } from 'mathlive';
import { configureMathField, loadMathLive } from '@/lib/equations/wysiwyg';

/**
 * A thin React wrapper over MathLive's <math-field>. The field is the
 * EDITING surface: its `input` event is the one latex producer; `latex`
 * flows back only for EXTERNAL changes (Source textarea, undo),
 * echo-guarded so the field never fights its own input. MathLive needs
 * real layout (jsdom has none) — on load failure `onUnavailable()` fires
 * ONCE and the bubble swaps to the Source textarea, never a crash.
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
  // Latest callbacks read by the MOUNT-time listeners through refs —
  // the field mounts once per bubble, but closures stay fresh.
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
        hostRef.current.appendChild(mf);
        // AFTER attachment — the option accessors require a mounted
        // field (configureMathField: smart typing, `/`→fraction).
        configureMathField(mf);
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
    // Mounts once per bubble open; latex and callbacks flow through
    // refs — the stable deps array needs no disable directive.
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