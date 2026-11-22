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
import { ColumnBreakNode } from '@/lib/pagination/ColumnBreakNode';
import { SectionBreakNode } from '@/lib/pagination/SectionBreakNode';
// The doc-level header/footer containers — content rides the ONE PM
// doc; the adapter routes them into doc.bands.
import { FooterBlock, HeaderBlock } from '@/lib/editor/HeaderFooterNodes';
// The markdown-mapped variants — the SAME nodes with markdown
// handlers; inert in production (nothing there builds a manager);
// lib/markdown/manager.ts builds its MarkdownManager from this list.
import { MarkdownImageNode, MarkdownInlineImageNode, MarkdownEquationNode } from '@/lib/markdown/specs';
import { PageFieldNode } from '@/lib/editor/PageFieldNode';
import { TensorTableKit } from '@/lib/editor/TableExtensions';
// Display equations — a block atom; latex is the only document data,
// rendering is a projection (lib/equations); the markdown-mapped
// variant comes from lib/markdown/specs.
// The reference-table node (ToC/ToF/Index) + the invisible indexEntry
// mark + the debounced rescan seam + the generator.
import { ReferenceTableNode } from '@/lib/editor/ReferenceTableNode';
import { IndexMark } from '@/lib/editor/IndexMark';
import { RefLeaderMark } from '@/lib/editor/RefLeaderMark';
// The comment mark (attrs.threadId) + the tracking plugin (anchored
// scan, the janitor, active-thread).
import { CommentMark } from '@/lib/editor/CommentExtension';
import { ReferenceScanExtension } from '@/lib/references/store';
import { ReferenceGeneratorExtension } from '@/lib/references/generator';
import { PageSetupHistoryExtension } from '@/lib/editor/pageSetupHistoryExtension';

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
    // The charStyle mark (registry reference) + apply/convert commands
    // + the reactive heading-sync plugin.
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
    ColumnBreakNode,
    // #58 — the sectionBreak atom; the adapter translates it into the
    // engine's per-section geometry boundaries (not part of the IR).
    SectionBreakNode,
    // The markdown-mapped image/equation nodes — same schema, same
    // names; the markdown handlers ride along, inert in production.
    MarkdownImageNode,
    MarkdownInlineImageNode,
    // The page-number field (bands resolve per page).
    PageFieldNode,
    // The TipTap table family (schema + commands + columnResizing via
    // `resizable`) plus Tensor's borderStyle/backgroundColor attrs.
    ...TensorTableKit,
    // The header/footer container nodes.
    HeaderBlock,
    FooterBlock,
    // Display equations — a block atom; latex is the only document
    // data, rendering is a projection (lib/equations).
    MarkdownEquationNode,
    // The reference tables (ToC/ToF/Index) + the invisible index mark +
    // the debounced rescan publisher + the generator.
    ReferenceTableNode,
    IndexMark,
    RefLeaderMark,
    // The invisible comment mark + tracking plugin (order among marks
    // is irrelevant; the plugin rides the mark's own registration).
    CommentMark,
    ReferenceScanExtension,
    ReferenceGeneratorExtension,
    // #58 — LAST: overrides StarterKit's undo/redo commands with the
    // page-setup co-restore (the store's pageSetup is outside PM —
    // the raw history would half-undo a page-setup action).
    PageSetupHistoryExtension,
    // Stable block ids (engine edit-survival contract) + the
    // paginated-mode scroll guard.
    BlockIdExtension,
    ScrollGuardExtension,
  ];
}