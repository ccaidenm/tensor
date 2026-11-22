export interface ShortcutDefinition {
  id: string;
  label: string;
  keys: string;
  /** 'editor': ProseMirror plugin, fires with editor focus only.
   *  'app': global window listener, fires regardless of focus.
   *  'os': OS-owned, listed for docs only. All but 'os' rebindable. */
  context: 'editor' | 'app' | 'os';
  category: string;
}

export const SHORTCUTS: ShortcutDefinition[] = [
  { id: 'save', label: 'Save', keys: 'ctrl+s', context: 'app', category: 'General' },
  // #100 — the native menu is gone; these are its absorbed accelerators.
  { id: 'open', label: 'Open', keys: 'ctrl+o', context: 'app', category: 'General' },
  { id: 'quit', label: 'Quit', keys: 'ctrl+q', context: 'app', category: 'General' },
  { id: 'new', label: 'New Document', keys: 'ctrl+n', context: 'app', category: 'General' },
  { id: 'openSettings', label: 'Open Settings', keys: 'ctrl+,', context: 'app', category: 'General' },
  { id: 'palette', label: 'Command Palette', keys: 'ctrl+shift+p', context: 'app', category: 'General' },
  // Word's convention; the preview is document-wide, not a caret action.
  { id: 'printPreview', label: 'Print Preview', keys: 'ctrl+p', context: 'app', category: 'General' },
  { id: 'undo', label: 'Undo', keys: 'ctrl+z', context: 'os', category: 'General' },
  { id: 'redo', label: 'Redo', keys: 'ctrl+y', context: 'os', category: 'General' },
  // Word's convention; the toggle is document-wide, not a caret action.
  { id: 'toggleSpellCheck', label: 'Toggle Spell Check', keys: 'f7', context: 'app', category: 'Review' },
  // F11 convention; fires with anything focused, mid-focus-mode included.
  { id: 'toggleFocusMode', label: 'Toggle Focus Mode', keys: 'f11', context: 'app', category: 'View' },
  // Word's convention; caret action — the selection guard lives in the command body.
  { id: 'addComment', label: 'Add Comment', keys: 'ctrl+alt+m', context: 'editor', category: 'Review' },

  { id: 'find', label: 'Find & Replace', keys: 'ctrl+f', context: 'editor', category: 'Search' },

  { id: 'bold', label: 'Bold', keys: 'ctrl+b', context: 'editor', category: 'Formatting' },
  { id: 'italic', label: 'Italic', keys: 'ctrl+i', context: 'editor', category: 'Formatting' },
  { id: 'underline', label: 'Underline', keys: 'ctrl+u', context: 'editor', category: 'Formatting' },
  { id: 'strike', label: 'Strikethrough', keys: 'ctrl+shift+x', context: 'editor', category: 'Formatting' },
  { id: 'clearFormatting', label: 'Clear Formatting', keys: 'ctrl+\\', context: 'editor', category: 'Formatting' },
  { id: 'fontSizeUp', label: 'Increase Font Size', keys: 'ctrl+shift+.', context: 'editor', category: 'Formatting' },
  { id: 'fontSizeDown', label: 'Decrease Font Size', keys: 'ctrl+shift+,', context: 'editor', category: 'Formatting' },

  { id: 'insertLink', label: 'Hyperlink', keys: 'ctrl+k', context: 'editor', category: 'Insert' },
  { id: 'insertPageBreak', label: 'Page Break', keys: 'ctrl+enter', context: 'editor', category: 'Insert' },
  // #58 — no default key (the page break owns ctrl+enter; the ribbon
  // and the palette carry the section break until a key is chosen).
  { id: 'insertSectionBreak', label: 'Section Break', keys: '', context: 'editor', category: 'Insert' },
  // #74 — no default key; the ribbon and palette carry it.
  { id: 'insertColumnBreak', label: 'Column Break', keys: '', context: 'editor', category: 'Insert' },
  // Word's equation shortcut convention (Alt+=).
  { id: 'insertEquation', label: 'Equation', keys: 'alt+=', context: 'editor', category: 'Insert' },

  { id: 'alignLeft', label: 'Align Left', keys: 'ctrl+shift+l', context: 'editor', category: 'Paragraphs' },
  { id: 'alignCenter', label: 'Align Center', keys: 'ctrl+shift+e', context: 'editor', category: 'Paragraphs' },
  { id: 'alignRight', label: 'Align Right', keys: 'ctrl+shift+r', context: 'editor', category: 'Paragraphs' },
  { id: 'alignJustify', label: 'Justify', keys: 'ctrl+shift+j', context: 'editor', category: 'Paragraphs' },
  { id: 'unorderedList', label: 'Bullet List', keys: 'ctrl+shift+8', context: 'editor', category: 'Paragraphs' },
  { id: 'orderedList', label: 'Numbered List', keys: 'ctrl+shift+7', context: 'editor', category: 'Paragraphs' },
  { id: 'increaseIndent', label: 'Increase Indent', keys: 'ctrl+]', context: 'editor', category: 'Paragraphs' },
  { id: 'decreaseIndent', label: 'Decrease Indent', keys: 'ctrl+[', context: 'editor', category: 'Paragraphs' },
];

/** The id's live binding — user override or registry default. Never
 *  index config.keybindings directly: older configs predate newer
 *  shortcuts and would resolve undefined. */
export function getEffectiveKeybinding(keybindings: Record<string, string>, id: string): string {
  const def = SHORTCUTS.find((s) => s.id === id);
  return keybindings[id] ?? def?.keys ?? '';
}

/** Shift+'.'/',' events deliver the shifted glyph ('>'/'<'); match both
 *  spellings so physical-key and glyph bindings both fire (Word displays
 *  Ctrl+Shift+>, the registry stores ctrl+shift+.). */
const SHIFT_GLYPH_ALIASES: Record<string, string> = {
  '>': '.',
  '<': ',',
};

export function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false;
  const parts = shortcut.toLowerCase().split('+');
  const key = parts.pop();
  if (key == null) return false;
  const eventKey = e.key.toLowerCase();
  return (
    (e.ctrlKey || e.metaKey) === parts.includes('ctrl') &&
    e.shiftKey === parts.includes('shift') &&
    e.altKey === parts.includes('alt') &&
    (eventKey === key ||
      SHIFT_GLYPH_ALIASES[eventKey] === key ||
      SHIFT_GLYPH_ALIASES[key] === eventKey)
  );
}

/** KeyboardEvent -> canonical binding string for the rebind UI. Null
 *  while only modifiers are held; bare letters are refused (they would
 *  break normal typing). */
export function captureShortcutString(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  if (e.key === 'Escape') return null; // reserved: always cancels recording

  const hasModifier = e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
  if (!hasModifier) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');

  let key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  parts.push(key);

  return parts.join('+');
}

/** Finds another (non-'os') shortcut currently bound to `candidateKeys`,
 *  excluding `excludeId` itself. Used by the rebind UI to flag conflicts
 *  against real current bindings, not just the static defaults. */
export function findLiveConflict(
  keybindings: Record<string, string>,
  excludeId: string,
  candidateKeys: string,
): ShortcutDefinition | null {
  if (!candidateKeys) return null;
  return (
    SHORTCUTS.find(
      (s) =>
        s.id !== excludeId &&
        s.context !== 'os' &&
        getEffectiveKeybinding(keybindings, s.id) === candidateKeys,
    ) ?? null
  );
}

/** Dev-time sanity check that the DEFAULT bindings (before any user
 *  customization) don't collide with each other. */
export function findShortcutConflicts(): string[][] {
  const seen = new Map<string, string[]>();
  for (const s of SHORTCUTS) {
    // #74 — unbound ('') entries can't collide.
    if (!s.keys) continue;
    const list = seen.get(s.keys) ?? [];
    list.push(s.id);
    seen.set(s.keys, list);
  }
  return [...seen.values()].filter((ids) => ids.length > 1);
}

export function formatShortcutParts(shortcut: string): string[] {
  return shortcut.split('+').map((part) => {
    if (part === 'ctrl') return 'Ctrl';
    if (part === 'shift') return 'Shift';
    if (part === 'alt') return 'Alt';
    if (part === 'meta') return 'Cmd';
    return part.toUpperCase();
  });
}
