import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { SearchMatch } from './SearchExtension';

interface SearchMatchesState {
  matches: SearchMatch[];
  currentIndex: number;
  regexError: string | null;
  groupCount: number;
}

const EMPTY_STATE: SearchMatchesState = { matches: [], currentIndex: -1, regexError: null, groupCount: 0 };

/**
 * Reactive read of the SearchExtension's storage (kept in sync with
 * PM plugin state by the extension's onTransaction hook).
 */
export function useSearchMatches(editor: Editor | null): SearchMatchesState {
  const [state, setState] = useState<SearchMatchesState>(EMPTY_STATE);

  useEffect(() => {
    if (!editor) {
      setState(EMPTY_STATE);
      return;
    }

    const sync = () => {
      const storage = editor.storage.search;
      setState({
        matches: storage?.matches ?? [],
        currentIndex: storage?.currentIndex ?? -1,
        regexError: storage?.regexError ?? null,
        groupCount: storage?.groupCount ?? 0,
      });
    };

    sync();
    editor.on('transaction', sync);
    return () => {
      editor.off('transaction', sync);
    };
  }, [editor]);

  return state;
}

/**
 * Scrolls the currently-highlighted match into view — shared by the
 * popup and the Advanced sidebar.
 */
export function useScrollToCurrentSearchMatch(currentIndex: number, matchCount: number) {
  useEffect(() => {
    if (currentIndex < 0 || matchCount === 0) return;
    const el = document.querySelector('.tensor-search-match-current');
    // Match decorations live in the PM view — the paginated hidden
    // input-only view's geometry is meaningless (scrollIntoView would
    // scroll to nonsense); the paginated path scrolls by painted coords.
    if (el?.closest('.pm-input-only')) return;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentIndex, matchCount]);
}
