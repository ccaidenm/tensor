import { useEffect, useRef } from 'react';
import { BookA, EyeOff } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import type { SpellError } from '@/lib/editor/spell/types';
import { useSpellStore } from '@/lib/editor/spell/store';

interface SpellBubbleProps {
  editor: Editor;
  error: SpellError;
  /** Viewport-relative anchor (already un-zoomed by the caller): the
   *  bubble's top-left corner, positioned just below the span. */
  left: number;
  top: number;
  onClose: () => void;
}

/**
 * The suggestion bubble: a plain LEFT-CLICK on a flagged span opens it
 * (right-click stays the context menu), at VIEWPORT coordinates outside
 * the zoom transform. Spelling: suggestions, Add to Dictionary, Ignore
 * all (word-scoped); grammar: explanation, suggestions, session Ignore
 * rule (grammar false positives are rule-shaped; dictionary actions
 * hide). Replacements ride a normal PM transaction — undoable by
 * construction. Dismissal: action, Escape, outside click, doc change.
 */
export function SpellBubble({ editor, error, left, top, onClose }: SpellBubbleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isGrammar = error.kind === 'grammar';

  // Click-outside and Escape dismissal. Capture-phase pointerdown so we
  // close BEFORE the surface's caret logic — a click on the same span
  // then re-opens (toggle).
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
    // A plain doc transaction through PM's own machinery — undoable,
    // remapping, history-grouped.
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

  function ignoreRule() {
    useSpellStore.getState().ignoreSessionRule(error.ruleId);
    // Every flag of this RULE vanishes now; future checks skip it via
    // the session-ignored-rules filter.
    editor.commands.ignoreSpellRule(error.ruleId);
    onClose();
  }

  return (
    <div
      ref={ref}
      data-spell-bubble
      data-word={error.word}
      data-kind={error.kind}
      // The bubble is its own click territory: the surface's mousedown
      // must not fire from inside it.
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute z-30 w-60 rounded-lg border border-border bg-popover p-1 text-sm shadow-md"
      style={{ left: `${left}px`, top: `${top}px` }}
    >
      {isGrammar && (
        <div className="px-2 pb-1.5 pt-1" data-testid="spell-grammar-explanation">
          <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <EyeOff size={11} />
            Grammar
          </div>
          <p className="line-clamp-3 text-xs leading-snug text-muted-foreground">
            {error.message}
          </p>
        </div>
      )}
      {error.suggestions.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground" data-testid="spell-no-suggestions">
          {isGrammar ? 'No suggested fix' : 'No spelling suggestions'}
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
      {!isGrammar ? (
        <>
          <button
            type="button"
            data-testid="spell-add-dict"
            className="flex w-full items-center gap-2 truncate rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            onClick={addToDictionary}
          >
            <BookA size={13} />
            <span className="truncate">Add &ldquo;{error.word}&rdquo; to Dictionary</span>
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
        </>
      ) : (
        <button
          type="button"
          data-testid="spell-ignore-rule"
          className="flex w-full items-center gap-2 truncate rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          onClick={ignoreRule}
        >
          <EyeOff size={13} />
          <span className="truncate">Ignore this rule (this session)</span>
        </button>
      )}
    </div>
  );
}
