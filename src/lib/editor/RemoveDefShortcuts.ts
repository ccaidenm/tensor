import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Underline from '@tiptap/extension-underline';
import Strike from '@tiptap/extension-strike';
import { TextAlign } from '@tiptap/extension-text-align';

/**
 * Removes all default keyboard shortcuts — application shortcuts are
 * configured by the custom shortcuts extensions.
 */
export const BoldNoShortcut = Bold.extend({ addKeyboardShortcuts() { return {}; } });
export const ItalicNoShortcut = Italic.extend({ addKeyboardShortcuts() { return {}; } });
export const UnderlineNoShortcut = Underline.extend({ addKeyboardShortcuts() { return {}; } });
export const StrikeNoShortcut = Strike.extend({ addKeyboardShortcuts() { return {}; } });
export const TextAlignNoShortcut = TextAlign.extend({ addKeyboardShortcuts() { return {}; } });
