import { useEffect, useRef } from 'react';
import { BookA, EyeOff } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import type { SpellError } from '@/lib/editor/spell/types';
import { useSpellStore } from '@/lib/editor/spell/store';

interface SpellBubbleProps {
  editor: Editor;
  error: SpellError;
  /** Viewport-relative anchor (already un-zoomed by the caller): the
   *  bubble's top-left corner, positioned just below the word. */
  left: number;
  top: number;
  onClose: () => void;
}

/**
 * THE SUGGESTION BUBBLE — GDocs-style: a plain LEFT-CLICK on a flagged
 * word opens this floating menu; the RIGHT-CLICK context menu stays for
 * the app's other actions (the explicit user ruling). Rendered by both
 * view modes at VIEWPORT coordinates (outside the paginated zoom
 * transform — the LinkBubble/FloatingToolbar chrome precedent).
 *
 * The replacement action rides a normal PM transaction (the search
 * replace spelling: tr.insertText), so UNDO HISTORY participation is
 * by construction — Ctrl+Z restores the misspelling.
 *
 * Dismissal rules (all of them): apply/add/ignore (an action was
 * taken), Escape, any click outside the bubble (document pointerdown
 * — covers the painted surface, the margins, and app chrome alike),
 * and any doc change (the view's 'update' listener — typing
 * invalidates the anchored word).
 */
export function SpellBubble({ editor, error, left, top, onClose }: SpellBubbleProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Click-outside and Escape dismissal. Capture phase for pointerdown
  // so we close BEFORE the surface's own mousedown caret logic runs
  // (the open handler below then re-opens for a click on the same word
  // — click again to toggle, GDocs behavior).
  useEffect(() => {
    const el = ref.current;
    const onPointerDown = (e: PointerEvent) => {
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  function applySuggestion(suggestion: string) {
    // The search-replace spelling: a plain doc transaction through
    // PM's own machinery — undoable, remapping, history-grouped.
    editor
      .chain()
      .focus()
      .command(({ tr, dispatch }) => {
        if (dispatch) tr.insertText(suggestion, error.from, error.to);
        return true;
      })
      .run();
    onClose();
  }

  function addToDictionary() {
    useSpellStore.getState().addDictionaryWord(error.word);
    // Flags for this word vanish NOW (every occurrence); future checks
    // skip it via the dictionary filter.
    editor.commands.ignoreSpellWord(error.word);
    onClose();
  }

  function ignoreAll() {
    useSpellStore.getState().ignoreSessionWord(error.word);
    editor.commands.ignoreSpellWord(error.word);
    onClose();
  }

  return (
    <div
      ref={ref}
      data-spell-bubble
      data-word={error.word}
      // The bubble is its own click territory: the surface's mousedown
      // must not fire from inside it (LinkBubble's stopPropagation).
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute z-30 w-56 rounded-lg border border-border bg-popover p-1 text-sm shadow-md"
      style={{ left: `${left}px`, top: `${top}px` }}
    >
      {error.suggestions.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground" data-testid="spell-no-suggestions">
          No spelling suggestions
        </div>
      ) : (
        error.suggestions.map((s, i) => (
          <button
            key={s}
            type="button"
            data-testid={`spell-sug-${i}`}
            className="block w-full truncate rounded px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            onClick={() => applySuggestion(s)}
          >
            {s}
          </button>
        ))
      )}
      <div className="my-1 h-px bg-border" />
      <button
        type="button"
        data-testid="spell-add-dict"
        className="flex w-full items-center gap-2 truncate rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
        onClick={addToDictionary}
      >
        <BookA size={13} />
        <span className="truncate">
          Add “{error.word}” to Dictionary
        </span>
      </button>
      <button
        type="button"
        data-testid="spell-ignore-all"
        className="flex w-full items-center gap-2 truncate rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
        onClick={ignoreAll}
      >
        <EyeOff size={13} />
        <span className="truncate">Ignore all (this session)</span>
      </button>
    </div>
  );
}
