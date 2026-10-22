import type { Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, FontSize } from '@tiptap/extension-text-style';
import FontFamily from '@tiptap/extension-font-family';
import { Color } from '@tiptap/extension-color';
import { Highlight } from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import {
  OrderedListWithStyle,
  UnorderedListWithStyle,
} from '@/lib/lists/listExtensions';
import { HeadingWithExtras, ParagraphExtraCommands, ParagraphWithExtras } from '@/lib/editor/ParagraphExtensions';
import { SearchExtension } from '@/lib/editor/search/SearchExtension';
import { SpellExtension } from '@/lib/editor/spell/SpellExtension';
import { DynamicShortcutsExtension } from '@/lib/editor/ShortcutsExtension';
import {
  BoldNoShortcut,
  ItalicNoShortcut,
  UnderlineNoShortcut,
  StrikeNoShortcut,
  TextAlignNoShortcut,
} from '@/lib/editor/RemoveDefShortcuts';
import { BlockIdExtension } from '@/lib/editor/BlockIdExtension';
import { CharStyleMark, StyleCommandsExtension } from '@/lib/styles/styleExtensions';
import { ScrollGuardExtension } from '@/lib/paginated/ScrollGuardExtension';
import { PageBreakNode } from '@/lib/pagination/PageBreakNode';
import { ImageNode } from '@/lib/editor/ImageNode';
import { InlineImageNode } from '@/lib/editor/InlineImageNode';
import { TensorTableKit } from '@/lib/editor/TableExtensions';
import { EquationNode } from '@/lib/editor/EquationNode';

/** The Tensor editor's extension list — one source shared by the app
 * shell (Editor.tsx) and the test harness so tests exercise the exact
 * production editor. */
export function tensorExtensions(): Extensions {
  return [
    StarterKit.configure({
      bulletList: false,
      orderedList: false,
      paragraph: false,
      heading: false,
      link: false,
      bold: false,
      italic: false,
      underline: false,
      strike: false,
    }),
    BoldNoShortcut,
    ItalicNoShortcut,
    UnderlineNoShortcut,
    StrikeNoShortcut,
    OrderedListWithStyle,
    UnorderedListWithStyle,
    TextStyle,
    FontFamily,
    Color,
    Highlight.configure({ multicolor: true }),
    FontSize,
    // M-STYLES: the charStyle mark (registry reference; one per span)
    // + apply/convert commands + the reactive heading-sync plugin.
    CharStyleMark,
    StyleCommandsExtension,
    TextAlignNoShortcut.configure({ types: ['heading', 'paragraph'] }),
    ParagraphWithExtras,
    HeadingWithExtras,
    ParagraphExtraCommands,
    Link.configure({
      openOnClick: false,
      HTMLAttributes: { target: null, rel: 'noopener noreferrer nofollow' },
    }),
    SearchExtension,
    // Spell check state holder: error spans + decorations (the
    // controller/store live app-side; this is the model layer both
    // view modes project).
    SpellExtension,
    DynamicShortcutsExtension,
    // Model node that survives from the legacy pipeline: the pageBreak
    // atom renders its marker, and the adapter translates it into the
    // engine's forced-break spelling (flow.breakBefore: 'page').
    PageBreakNode,
    ImageNode,
    InlineImageNode,
    // M-TABLES: the TipTap table family (schema + commands + the
    // built-in columnResizing plugin via `resizable`) plus Tensor's
    // borderStyle/backgroundColor attrs. Pages mode falls back to the
    // pageless render until the engine grows the TableBlock kind.
    ...TensorTableKit,
    // M-EQ: display equations — a block atom (the ImageNode family);
    // latex is the node's only document data, rendering is a
    // projection (lib/equations), paginated layout rides the engine's
    // EquationBlock + EquationMetrics port.
    EquationNode,
    // Stable block ids (engine edit-survival contract) + the
    // paginated-mode scroll guard (L3).
    BlockIdExtension,
    ScrollGuardExtension,
  ];
}