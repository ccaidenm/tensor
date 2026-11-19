import type { LucideIcon } from 'lucide-react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  CaseSensitive,
  ClipboardPaste,
  Copy,
  FileSearchCorner,
  FileStack,
  FolderOpen,
  Heading1,
  Heading2,
  Heading3,
  IndentDecrease,
  IndentIncrease,
  Info,
  Image as ImageIcon,
  Italic,
  Library,
  Link2,
  List,
  ListOrdered,
  LogOut,
  Maximize,
  Moon,
  Pilcrow,
  Plus,
  Quote,
  Redo2,
  RemoveFormatting,
  Ruler,
  Save,
  SaveAll,
  Scissors,
  SeparatorHorizontal,
  Settings,
  Sigma,
  Sparkles,
  SpellCheck,
  Strikethrough,
  Underline as UnderlineIcon,
  MessageSquareText,
  TextCursorInput,
  Squircle,
  Table,
  TableProperties,
  PersonStanding,
  Droplet,
  BookmarkMinus,
  BookmarkPlus,
  BookOpen,
  WrapText,
  BringToFront,
  SendToBack,
  Undo2,
  ZoomIn,
  ZoomOut,
  PanelTop,
  PanelBottom,
  Eye,
  Eraser,
  FileDown,
  FileText,
  Printer,
  Proportions,
  Languages,
} from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { pasteFromSystemClipboard } from '@/lib/editor/clipboard';
import { enableRegion, hasBandContainer, selectionInBand } from '@/lib/editor/headerFooterCommands';
import { findTableUnderSelection } from '@/lib/editor/TableExtensions';
import { cloneHeaderFooterSettings, defaultHeaderFooterSettings } from '@/lib/document/headerFooter';
import { runEditorCommand } from '@/lib/editor/editorCommands';
import { focusedTextControl } from '@/lib/editor/domUtils';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { saveRecoveryCopy } from '@/lib/document/recovery';
import { useDocumentStore } from '@/lib/document/store';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { useConfigStore } from '@/lib/config/store';
import { useSettingsDialogStore } from '@/lib/settings/store';
import { usePaletteStore } from '@/lib/palette/store';
import { useStyleDialogStore } from '@/lib/styles/dialogStore';
import { useFontBrowserStore } from '@/lib/fonts/browserStore';
import { insertCaptionForImage } from '@/lib/media/caption';
import { insertImageFromPicker } from '@/lib/media/insert';
import { setWrapMode } from '@/lib/media/wrap';
import { useAltTextStore } from '@/components/dialogs/ImageDialogs';
import { useInsertTableStore } from '@/components/dialogs/InsertTableDialog';
import { usePrintPreviewStore } from '@/components/dialogs/PrintPreviewDialog';
import { useInsertReferenceTableStore } from '@/components/dialogs/InsertReferenceTableDialog';
import { insertReferenceTableAtSelection } from '@/lib/editor/ReferenceTableNode';
import { indexEntryActive } from '@/lib/editor/IndexMark';
import { useSpellStore } from '@/lib/editor/spell/store';
import { spellCheckActive } from '@/lib/config/schema';

/**
 * M-PALETTE. The declarative app command registry — the single source
 * of truth for app actions, consumed by BOTH the native menu
 * (useMenuEvents dispatches menu-event payloads through here) and the
 * command palette. Menu and palette cannot drift: they run the same
 * run() bodies.
 *
 * Editor commands are NOT re-implemented here — each entry dispatches
 * through the shared EDITOR_COMMAND_MAP path (editorCommands.ts), the
 * same one ShortcutsExtension uses for keybindings.
 */

export type CommandGroup = 'actions' | 'format' | 'navigate';

export interface CommandAction {
  id: string;
  title: string;
  icon?: LucideIcon;
  group: CommandGroup;
  /** Invocation contexts. 'app' = always available (default);
   *  'editor' = only while the editor surface had focus at palette
   *  open time. */
  contexts?: ('app' | 'editor')[];
  /** The Tauri native-menu item this action backs (menu-event
   *  payload id, src-tauri/src/lib.rs). Present = the menu dispatches
   *  this same registry entry. */
  menuEventId?: string;
  /** SHORTCUTS id whose LIVE binding (user-rebindable) the palette
   *  renders as a hint via getEffectiveKeybinding. */
  shortcutId?: string;
  keywords: string[];
  /** Palette VISIBILITY filter only — run() and menu dispatch ignore
   *  it, so a hidden action still fires from the menu. */
  hidden?: () => boolean;
  /** Destructive surface marker (quit; 'new' once real): run() must
   *  first persist a recovery snapshot of unsaved work via the
   *  existing autosave recovery path — same format, same recovery/
   *  location, so the existing restore flow picks it up with zero new
   *  machinery. */
  requiresSafeQuit?: boolean;
  /** Palette availability filter only — run() ignores it. Must be
   *  cheaply/synchronously readable from store state; if not, omit
   *  (never guess). */
  enablement?: () => boolean;
  run: () => void | Promise<void>;
}

const doc = () => useDocumentStore.getState();
const cfg = () => useConfigStore.getState();

/** M-REFS: the insert trio's shared enablement — editor present AND
 * the insertion not refused (bands/cells — the same facts the ONE
 * insertion helper toasts on; a disabled button must never write). */
const canInsertReferenceTable = () => {
  const editor = doc().editor;
  return !!editor && !selectionInBand(editor) && !findTableUnderSelection(editor.state);
};

/** enablement: cheap + sync (store reads, editor.can()). */
const canUndo = () => doc().editor?.can().undo() ?? false;
const canRedo = () => doc().editor?.can().redo() ?? false;
const isDirty = () => doc().isDirty;

/** Editor-context formatting entry: dispatches the shared
 *  ShortcutsExtension command path by id — never re-implemented. */
function editorCommand(id: string, def: Omit<CommandAction, 'id' | 'run' | 'contexts'>): CommandAction {
  return { ...def, id, contexts: ['editor'], run: () => { runEditorCommand(id); } };
}

/** ─── M-IMAGES-1.5 module-scope image helpers (shared by the
 * command closure and the direct-entry write above). ──────────────
 * M-IMAGES-2.1: BOTH node kinds qualify (block image + inlineImage)
 * — a NodeSelection on either is an image selection. `kind` narrows
 * when a command is shape-specific (align is a BLOCK-only fact — the
 * adapter reads align on kind 'image' alone; inline objects are
 * seated by the engine's baseline rule, so their align attr is
 * inert). */
function selectedImageRef(kind?: 'image' | 'inlineImage'): { pos: number; attrs: Record<string, unknown> } | null {
  const editor = useDocumentStore.getState().editor;
  if (!editor) return null;
  const sel = editor.state.selection as unknown as {
    node?: { type?: { name?: string }; attrs?: Record<string, unknown> };
    from?: number;
  };
  const name = sel.node?.type?.name;
  const isImageKind = name === 'image' || name === 'inlineImage';
  if (!isImageKind || (kind !== undefined && name !== kind) || typeof sel.from !== 'number') return null;
  return { pos: sel.from, attrs: sel.node!.attrs ?? {} };
}

/** Radius law: clamp to [0, half the min dim] — an extreme radius
 *  becomes the circle-ish pill, never a lie. */
function clampRadiusRef(value: number, attrs: Record<string, unknown>): number {
  const w = typeof attrs.width === 'number' ? attrs.width : 0;
  const h = typeof attrs.height === 'number' ? attrs.height : 0;
  const max = Math.floor(Math.min(w, h) / 2);
  return Math.max(0, Math.min(max, value));
}

/** One attr write on the selected image (setNodeAttribute — the
 *  standard PM path; paint-only attrs splice, geometry attrs
 *  relayout). `kind` narrows the accepted selection shape — align
 *  passes 'image' (a BLOCK-only fact; the enablement and the write
 *  must agree, or a disabled button would still write dead state). */
function writeImageAttrsRef(writes: Record<string, unknown>, kind?: 'image' | 'inlineImage'): void {
  const editor = useDocumentStore.getState().editor;
  const sel = selectedImageRef(kind);
  if (!editor || !sel) return;
  editor
    .chain()
    .command(({ tr, dispatch }) => {
      if (dispatch) {
        for (const [key, value] of Object.entries(writes)) tr.setNodeAttribute(sel.pos, key, value);
      }
      return true;
    })
    .run();
}

export const COMMANDS: CommandAction[] = [
  // ── Actions (menu-seeded — the useMenuEvents receipts) ────────────
  {
    id: 'new',
    title: 'New Document',
    icon: FileStack,
    group: 'navigate',
    menuEventId: 'menu-new',
    keywords: ['new', 'document', 'window', 'blank'],
    // Stub receipt (useMenuEvents): "New Document not yet implemented" —
    // a console.warn no-op that would LOOK broken in a palette. Hidden
    // from the palette until real; the menu still dispatches it.
    // When implemented: unhide AND add requiresSafeQuit (unsaved work
    // in the current doc must survive the switch).
    hidden: () => true,
    run: () => {
      console.warn('New Document not yet implemented');
    },
  },
  {
    id: 'open',
    title: 'Open Document',
    icon: FolderOpen,
    group: 'actions',
    menuEventId: 'menu-open',
    keywords: ['open', 'file', 'load', 'document'],
    run: () => void doc().openFile(),
  },
  {
    // M-IMAGES-2.2 — Insert > Image through the palette: the SAME
    // pipeline as the ribbon's Illustrations button (OS picker → the
    // ONE insertion pipeline, media/insert.ts). No keyboard shortcut —
    // the palette IS the reach.
    id: 'insertImage',
    title: 'Insert Image',
    icon: ImageIcon,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['insert', 'image', 'picture', 'photo', 'upload', 'media'],
    enablement: () => !!doc().editor,
    run: () => {
      const editor = doc().editor;
      if (editor) void insertImageFromPicker(editor);
    },
  },
  {
    // M-TABLES — Insert > Table through the palette: opens the same
    // exact-dimension dialog the ribbon grid picker's "Insert Table…"
    // opens. No keyboard shortcut — the palette IS the reach.
    id: 'insertTable',
    title: 'Insert Table…',
    icon: Table,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['insert', 'table', 'grid', 'rows', 'columns', 'cells'],
    enablement: () => !!doc().editor,
    run: () => {
      useInsertTableStore.getState().open();
    },
  },
  {
    id: 'save',
    title: 'Save',
    icon: Save,
    group: 'actions',
    menuEventId: 'menu-save',
    shortcutId: 'save',
    keywords: ['save', 'store', 'write', 'disk'],
    enablement: isDirty,
    run: () => void doc().save(),
  },
  {
    id: 'saveAs',
    title: 'Save As',
    icon: SaveAll,
    group: 'actions',
    menuEventId: 'menu-save-as',
    keywords: ['save', 'save as', 'export', 'rename', 'file'],
    run: () => void doc().saveAs(),
  },
  {
    id: 'exportMarkdown',
    title: 'Export Markdown',
    icon: FileDown,
    group: 'actions',
    // M-MD: palette-only for now (ruling 6) — the native menu item can
    // ride along with the PDF/DOCX export entries. The lossy confirm
    // lives inside exportMarkdownFile, so palette and menu share it.
    keywords: ['export', 'markdown', 'md', 'convert', 'save as'],
    enablement: () => !!doc().editor,
    run: () => void doc().exportMarkdown(),
  },
  {
    id: 'printPreview',
    title: 'Print Preview',
    icon: Printer,
    group: 'actions',
    shortcutId: 'printPreview',
    // M-PRINT (#43, Mark 3): the preview modal — the Chromium-style
    // print surface (Mark 2's Print command joins it).
    keywords: ['print', 'preview', 'printer', 'pdf'],
    enablement: () => !!doc().editor,
    run: () => usePrintPreviewStore.getState().open(),
  },
  {
    id: 'exportDocx',
    title: 'Export Word Document',
    icon: FileText,
    group: 'actions',
    // M-DOCX (#37): same one-body law — the gate lives in exportDocxFile.
    keywords: ['export', 'word', 'docx', 'microsoft', 'convert', 'save as'],
    enablement: () => !!doc().editor,
    run: () => void doc().exportDocx(),
  },
  {
    id: 'undo',
    title: 'Undo',
    icon: Undo2,
    group: 'actions',
    menuEventId: 'menu-undo',
    shortcutId: 'undo',
    keywords: ['undo', 'revert', 'history'],
    enablement: canUndo,
    run: () => {
      // A focused text control (dialog fields) owns undo: the native
      // menu accelerator consumed the keystroke, so execCommand
      // replays it on THAT control's own history — the same
      // focused-surface stance as cut/copy below.
      if (focusedTextControl()) {
        document.execCommand('undo');
        return;
      }
      doc().editor?.commands.undo();
    },
  },
  {
    id: 'redo',
    title: 'Redo',
    icon: Redo2,
    group: 'actions',
    menuEventId: 'menu-redo',
    shortcutId: 'redo',
    keywords: ['redo', 'repeat', 'history'],
    enablement: canRedo,
    run: () => {
      // Focused-text-control routing — see undo.
      if (focusedTextControl()) {
        document.execCommand('redo');
        return;
      }
      doc().editor?.commands.redo();
    },
  },
  {
    id: 'cut',
    title: 'Cut',
    icon: Scissors,
    group: 'actions',
    menuEventId: 'menu-cut',
    keywords: ['cut', 'clipboard', 'selection'],
    // TODO(Clipboard API): document.execCommand is deprecated but
    // universally supported — replacing it is not this milestone.
    run: () => {
      document.execCommand('cut');
    },
  },
  {
    id: 'copy',
    title: 'Copy',
    icon: Copy,
    group: 'actions',
    menuEventId: 'menu-copy',
    keywords: ['copy', 'clipboard', 'duplicate'],
    // TODO(Clipboard API): see cut — execCommand v1, not this milestone.
    run: () => {
      document.execCommand('copy');
    },
  },
  {
    id: 'paste',
    title: 'Paste',
    icon: ClipboardPaste,
    group: 'actions',
    menuEventId: 'menu-paste',
    keywords: ['paste', 'clipboard'],
    // Enablement omitted by law: clipboard emptiness is not cheaply/
    // synchronously readable (async + permission-gated) — never guess.
    run: () => {
      const editor = doc().editor;
      if (editor) void pasteFromSystemClipboard(editor);
    },
  },
  {
    id: 'toggleDarkMode',
    title: 'Toggle Dark Mode',
    icon: Moon,
    group: 'actions',
    menuEventId: 'menu-toggle-dark-mode',
    keywords: ['dark', 'light', 'theme', 'mode', 'night'],
    run: () => {
      const { config, setTheme } = cfg();
      setTheme(config.theme === 'dark' ? 'light' : 'dark');
    },
  },
    // M-RULER: ONE toggle for both ruler bars (the config's
  // showHorizontalRuler/showVerticalRuler flags — either visible → hide
  // both; else show both — mirroring the ribbon button). Pages mode
  // only; the bars unmount themselves outside it.
  {
    id: 'toggleRulers',
    title: 'Toggle Rulers',
    icon: Ruler,
    group: 'actions',
    keywords: ['ruler', 'rulers', 'show', 'hide', 'toggle', 'margins', 'tabs'],
    run: () => {
      const c = cfg().config.editor;
      cfg().setBothRulers(!(c.showHorizontalRuler || c.showVerticalRuler));
    },
  },
  {
    id: 'quit',
    title: 'Quit',
    icon: LogOut,
    group: 'actions',
    menuEventId: 'menu-quit',
    keywords: ['quit', 'exit', 'close', 'shutdown'],
    requiresSafeQuit: true,
    run: async () => {
      const { editor, filePath, isDirty, pageSetup, lineNumbers, coreProperties, headerFooter } = doc();
      // Safe-quit: dirty doc → recovery snapshot NOW via the EXISTING
      // autosave recovery path (recovery.ts saveRecoveryCopy — same
      // format, same appDataDir()/recovery/ location), so the existing
      // restore flow picks it up. No second snapshot format, no
      // forked restore logic.
      if (editor && isDirty) {
        await saveRecoveryCopy(editor, filePath, {
          pageSetup,
          lineNumbers,
          coreProperties,
          headerFooter,
        });
      }
      getCurrentWindow().close();
    },
  },

  // ── Actions (non-menu) ───────────────────────────────────────────
  {
    id: 'openSettings',
    title: 'Open Settings',
    icon: Settings,
    group: 'actions',
    shortcutId: 'openSettings',
    keywords: ['settings', 'preferences', 'options', 'config', 'configure'],
    run: () => useSettingsDialogStore.getState().open(),
  },
  {
    id: 'browseFonts',
    title: 'Browse Fonts',
    icon: Library,
    group: 'actions',
    keywords: ['fonts', 'font family', 'install', 'upload', 'typeface', 'browse'],
    run: () => useFontBrowserStore.getState().open(),
  },
  {
    id: 'createStyle',
    title: 'Create Style',
    icon: Plus,
    group: 'format',
    keywords: ['style', 'create', 'new', 'define', 'format'],
    run: () => useStyleDialogStore.getState().openDialog(null, 'paragraph'),
  },
  {
    id: 'palette',
    title: 'Command Palette',
    group: 'actions',
    shortcutId: 'palette',
    keywords: ['palette', 'command', 'search', 'actions', 'run'],
    run: () => usePaletteStore.getState().toggle(),
  },

  // ── Navigate (docs: view/document navigation & window) ───────────
  {
    id: 'documentProperties',
    title: 'Document Properties',
    icon: Info,
    group: 'navigate',
    keywords: ['properties', 'metadata', 'title', 'author', 'subject', 'keywords', 'comments', 'document', 'info'],
    run: () => useDocumentPropertiesStore.getState().open(),
  },
  // #58 — the ONE page-setup surface (paper/orientation/margins with
  // an Apply-to scope), palette-reachable like its sibling dialogs.
  {
    id: 'pageSetup',
    title: 'Page Setup',
    icon: Proportions,
    group: 'navigate',
    keywords: ['page', 'setup', 'paper', 'size', 'orientation', 'margins', 'section', 'landscape', 'portrait'],
    run: () => useDocumentPropertiesStore.getState().openPageSetup(),
  },
  {
    id: 'documentStatistics',
    title: 'Document Statistics',
    icon: Sparkles,
    group: 'navigate',
    keywords: ['statistics', 'stats', 'words', 'count', 'document'],
    run: () => useDocumentPropertiesStore.getState().openStats(),
  },
  {
    id: 'findSidebar',
    title: 'Find & Replace (Sidebar)',
    icon: FileSearchCorner,
    group: 'navigate',
    shortcutId: 'find',
    keywords: ['find', 'search', 'replace', 'sidebar', 'advanced'],
    run: () => useSidebarStore.getState().open('search', 'right'),
  },
  {
    // M-T3c — the Table side panel (the Find/Replace sidebar's twin):
    // dimensions + flow fine-tuning, and the alternate route for the
    // table ops when the floating toolbar is turned off.
    id: 'tableSidebar',
    title: 'Table Properties (Sidebar)',
    icon: TableProperties,
    group: 'navigate',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['table', 'properties', 'sidebar', 'panel', 'dimensions', 'columns', 'rows', 'width', 'height', 'merge', 'shading'],
    enablement: () => !!doc().editor,
    run: () => useSidebarStore.getState().open('table', 'right'),
  },
  {
    // M-A11Y — the Accessibility Check panel: the document-content
    // checker (missing alt text, heading hierarchy, color contrast),
    // on-demand from the Review tab or the palette. Palette-only — no
    // menuEventId, zero Rust surface (the tableSidebar precedent).
    id: 'accessibilityCheck',
    title: 'Check Accessibility',
    icon: PersonStanding,
    group: 'navigate',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['accessibility', 'a11y', 'check', 'checker', 'issues', 'alt text', 'headings', 'contrast', 'review'],
    enablement: () => !!doc().editor,
    run: () => useSidebarStore.getState().open('accessibilityCheck', 'right'),
  },
  {
    // #WATERMARK — the watermark panel: the decorative page overlay's
    // editor (text/image, rotation/opacity, whole document or one
    // section), docked beside Find/Table/Accessibility. Palette-only —
    // zero Rust surface (the tableSidebar precedent).
    id: 'watermarkPanel',
    title: 'Watermark',
    icon: Droplet,
    group: 'navigate',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['watermark', 'draft', 'confidential', 'background', 'overlay', 'insert'],
    enablement: () => !!doc().editor,
    run: () => useSidebarStore.getState().open('watermark', 'right'),
  },
  {
    // TRANSLATE — the Review tab's on-demand translation (the
    // accessibilityCheck twin): opens the docked panel. Palette-only —
    // no menuEventId, zero Rust surface beyond the translate wire
    // commands the consented runs invoke.
    id: 'translateSidebar',
    title: 'Translate',
    icon: Languages,
    group: 'navigate',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['translate', 'translation', 'language', 'libretranslate', 'bilingual', 'review'],
    enablement: () => !!doc().editor,
    run: () => useSidebarStore.getState().open('translate', 'right'),
  },

  // ─── M-HEADER-FOOTER-3: the header/footer commands. Enablement rides
  // PRESENCE (the band containers in the one PM doc) — the same fact the
  // Insert buttons' active state reads. ─────────────────────────────
  {
    id: 'insertHeader',
    title: 'Insert Header',
    icon: PanelTop,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['header', 'insert', 'band', 'top', 'margin'],
    enablement: () => !!doc().editor,
    run: () => enableRegion(doc().editor, 'header'),
  },
  {
    id: 'insertFooter',
    title: 'Insert Footer',
    icon: PanelBottom,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['footer', 'insert', 'band', 'bottom', 'margin'],
    enablement: () => !!doc().editor,
    run: () => enableRegion(doc().editor, 'footer'),
  },
  {
    id: 'toggleShowHeadersFooters',
    title: 'Toggle Headers & Footers',
    icon: Eye,
    group: 'navigate',
    keywords: ['header', 'footer', 'show', 'hide', 'display', 'toggle', 'band'],
    // The captions/ruler NPC pattern: a DISPLAY toggle is always
    // offered (presentation-only; the model round-trips regardless).
    run: () => {
      const { config, setShowHeadersFooters } = cfg();
      setShowHeadersFooters(!config.editor.showHeadersFooters);
    },
  },
  {
    id: 'removeAllHeadersFooters',
    title: 'Remove All Headers & Footers',
    icon: Eraser,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['header', 'footer', 'remove', 'delete', 'clear', 'band', 'all'],
    // Enablement is honest: nothing to remove → the palette hides it.
    // Runs delete every band container node (content included) and
    // reset differentFirstPage — undoable (one PM history step each).
    enablement: () => {
      const editor = doc().editor;
      return (
        !!editor &&
        (hasBandContainer(editor, 'header') ||
          hasBandContainer(editor, 'footer') ||
          (doc().headerFooter?.differentFirstPage ?? false))
      );
    },
    run: () => {
      const editor = doc().editor;
      if (!editor) return;
      // COLLECT then delete in REVERSE document order — deleting while
      // walking invalidates the later positions (the "Position N out of
      // range" crash the test caught). One PM step, so undo restores
      // everything at once.
      const targets: Array<{ pos: number; size: number }> = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'headerBlock' && node.type.name !== 'footerBlock') return true;
        targets.push({ pos, size: node.nodeSize });
        return false; // children die with the container
      });
      if (targets.length > 0) {
        const tr = editor.state.tr;
        for (const { pos, size } of targets.reverse()) tr.delete(pos, pos + size);
        editor.view.dispatch(tr);
      }
      const store = doc();
      const current = store.headerFooter ?? defaultHeaderFooterSettings();
      if (current.differentFirstPage) {
        store.setHeaderFooter({
          ...cloneHeaderFooterSettings(current),
          differentFirstPage: false,
        });
      }
    },
  },
  // ─── M-REFS: the reference-table commands (palette + menu share
  // the SAME runs — the M-PALETTE law). The insert trio routes through
  // the ONE insertion helper (refusal checks + toast + command); the
  // mark pair dispatches the schema commands. Enablement is honest and
  // cheap: editor presence + the refusal facts + selection shape. ───
  {
    id: 'insertTableOfContents',
    title: 'Insert Table of Contents',
    icon: List,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['insert', 'table of contents', 'toc', 'contents', 'headings', 'reference'],
    enablement: () => canInsertReferenceTable(),
    run: () => useInsertReferenceTableStore.getState().open(),
  },
  {
    id: 'insertTableOfFigures',
    title: 'Insert Table of Figures',
    icon: ImageIcon,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['insert', 'table of figures', 'figures', 'captions', 'images', 'reference'],
    enablement: () => canInsertReferenceTable(),
    run: () => {
      const editor = doc().editor;
      if (editor) insertReferenceTableAtSelection(editor, 'figures');
    },
  },
  {
    id: 'insertIndex',
    title: 'Insert Index',
    icon: BookOpen,
    group: 'actions',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['insert', 'index', 'terms', 'marked', 'reference', 'alphabetical'],
    enablement: () => canInsertReferenceTable(),
    run: () => {
      const editor = doc().editor;
      if (editor) insertReferenceTableAtSelection(editor, 'index');
    },
  },
  {
    id: 'markIndexEntry',
    title: 'Mark as Index Entry',
    icon: BookmarkPlus,
    group: 'format',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['index', 'mark', 'entry', 'term', 'keyword', 'reference'],
    // The mark's whole contract: a non-empty selection.
    enablement: () => !!doc().editor && !doc().editor!.state.selection.empty,
    run: () => doc().editor?.chain().focus().setIndexEntry().run(),
  },
  {
    id: 'removeIndexEntry',
    title: 'Remove Index Entry Mark',
    icon: BookmarkMinus,
    group: 'format',
    contexts: ['editor'] as ('app' | 'editor')[],
    keywords: ['index', 'remove', 'unmark', 'entry', 'term', 'mark'],
    enablement: () => !!doc().editor && indexEntryActive(doc().editor!.state),
    run: () => doc().editor?.chain().focus().unsetIndexEntry().run(),
  },

  {
    id: 'toggleNPC',
    title: 'Toggle Non-Printing Characters',
    icon: Pilcrow,
    group: 'navigate',
    keywords: ['non-printing', 'nonprinting', 'pilcrow', 'paragraph marks', 'npc', 'formatting marks'],
    run: () => {
      const { config, setShowNonPrintingChars } = cfg();
      setShowNonPrintingChars(!config.editor.showNonPrintingChars);
    },
  },
  {
    id: 'toggleLineNumbers',
    title: 'Toggle Line Numbers',
    icon: List,
    group: 'navigate',
    keywords: ['line numbers', 'gutter', 'numbering', 'count', 'lines'],
    // No enablement predicate by design: toggling is always offered —
    // it writes the DOCUMENT's setting (marks dirty), not app config.
    run: () => {
      const store = useDocumentStore.getState();
      const current = store.lineNumbers;
      store.setLineNumbers({
        enabled: !(current?.enabled ?? false),
        mode: current?.mode ?? 'per-page',
        countBy: current?.countBy,
      });
    },
  },
  {
    id: 'toggleSpellCheck',
    title: 'Toggle Spelling & Grammar',
    icon: SpellCheck,
    group: 'navigate',
    keywords: ['spell', 'spelling', 'grammar', 'check', 'proof', 'proofing', 'languagetool'],
    // The consent gate (the ribbon button's rule): the FIRST enable
    // opens the setup dialog — the provider choice is never defaulted.
    // MASTER semantic: flips both features together (Settings →
    // Proofing holds the per-feature switches).
    run: () => {
      const { config, setSpellCheckEnabled } = cfg();
      if (!config.spellCheck.configured) {
        useSpellStore.getState().openSetup();
        return;
      }
      setSpellCheckEnabled(!spellCheckActive(config.spellCheck));
    },
  },
  // ─── M-IMAGES-1.5: the image commands (toolbar + palette dispatch
  // through the same runs; editor-context, enablement = an image node
  // is SELECTED — a NodeSelection). ──────────────────────────────
  ...(() => {
    const imageSelected = () => selectedImageRef() !== null;
    // M-IMAGES-2.1: align is a BLOCK-image fact (the adapter reads it
    // on kind 'image' alone; an inline object's align attr is inert —
    // the engine seats objects by baseline). Enablement is honest:
    // block selection only.
    const blockImageSelected = () => selectedImageRef('image') !== null;
    const RADIUS_STEP = 4;
    const alignCommand = (align: 'left' | 'center' | 'right') => ({
      id: `imageAlign${align === 'left' ? 'Left' : align === 'center' ? 'Center' : 'Right'}`,
      title: `Align Image ${align === 'left' ? 'Left' : align === 'center' ? 'Center' : 'Right'}`,
      icon: align === 'left' ? AlignLeft : align === 'center' ? AlignCenter : AlignRight,
      group: 'format' as const,
      contexts: ['editor'] as ('app' | 'editor')[],
      keywords: ['image', 'align', align],
      enablement: blockImageSelected,
      run: () => writeImageAttrsRef({ align }, 'image'),
    });
    return [
      alignCommand('left'),
      alignCommand('center'),
      alignCommand('right'),
      {
        id: 'imageAddCaption',
        title: 'Add Caption to Image',
        icon: MessageSquareText,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'caption', 'figure', 'label'],
        enablement: imageSelected,
        run: () => {
          const editor = useDocumentStore.getState().editor;
          if (editor) insertCaptionForImage(editor);
        },
      },
      {
        id: 'imageAltText',
        title: 'Edit Image Alt Text',
        icon: TextCursorInput,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'alt', 'accessibility', 'description'],
        enablement: imageSelected,
        run: () => {
          const sel = selectedImageRef();
          if (sel) {
            useAltTextStore
              .getState()
              .open(
                sel.pos,
                String(sel.attrs.alt ?? ''),
                (sel.attrs.src as string | null) ?? null,
                sel.attrs.decorative === true,
              );
          }
        },
      },
      {
        id: 'imageRadiusUp',
        title: 'Increase Image Corner Radius',
        icon: Squircle,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'radius', 'corner', 'round'],
        enablement: imageSelected,
        run: () => {
          const sel = selectedImageRef();
          if (!sel) return;
          const next = clampRadiusRef(Number(sel.attrs.radius ?? 0) + RADIUS_STEP, sel.attrs);
          writeImageAttrsRef({ radius: next });
        },
      },
      {
        id: 'imageRadiusDown',
        title: 'Decrease Image Corner Radius',
        icon: Squircle,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'radius', 'corner', 'round'],
        enablement: imageSelected,
        run: () => {
          const sel = selectedImageRef();
          if (!sel) return;
          const next = clampRadiusRef(Number(sel.attrs.radius ?? 0) - RADIUS_STEP, sel.attrs);
          writeImageAttrsRef({ radius: next });
        },
      },
      {
        id: 'imageWrapInline',
        title: 'Image: In Line with Text',
        icon: WrapText,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'wrap', 'inline', 'text', 'convert'],
        enablement: imageSelected,
        run: () => {
          const editor = useDocumentStore.getState().editor;
          if (editor) setWrapMode(editor, 'inline');
        },
      },
      {
        id: 'imageWrapFront',
        title: 'Image: In Front of Text',
        icon: BringToFront,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'wrap', 'float', 'front', 'anchor'],
        enablement: imageSelected,
        run: () => {
          const editor = useDocumentStore.getState().editor;
          if (editor) setWrapMode(editor, 'front');
        },
      },
      {
        id: 'imageWrapBehind',
        title: 'Image: Behind Text',
        icon: SendToBack,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'wrap', 'float', 'behind', 'background'],
        enablement: imageSelected,
        run: () => {
          const editor = useDocumentStore.getState().editor;
          if (editor) setWrapMode(editor, 'behind');
        },
      },
      {
        id: 'imageWrap',
        title: 'Wrap Text Around Image',
        icon: WrapText,
        group: 'format' as const,
        contexts: ['editor'] as ('app' | 'editor')[],
        keywords: ['image', 'wrap', 'float', 'inline'],
        // M-IMAGES-2 lights this (inline/floats) — the stub ships
        // disabled everywhere (palette filters it out via enablement;
        // the toolbar shows it disabled).
        enablement: () => false,
        run: () => {},
      },
    ];
  })(),

  // The mode flavors — every one enables with its mode; invoking the
  // command while ALREADY in that exact state turns the gutter off
  // (toggle semantics, so the palette alone can fully drive the
  // setting without the ribbon).
  ...(['per-page', 'continuous', 'per-paragraph'] as const).map((mode) => ({
    id: `lineNumbers:${mode}`,
    title: `Line Numbers: ${mode === 'per-page' ? 'Per Page' : mode === 'per-paragraph' ? 'Per Paragraph' : 'Continuous'}`,
    icon: ListOrdered,
    group: 'navigate' as const,
    keywords: ['line numbers', 'gutter', 'numbering', mode.replace('-', ' '), 'count', 'lines'],
    run: () => {
      const store = useDocumentStore.getState();
      const current = store.lineNumbers;
      const alreadyActive = current?.enabled === true && current.mode === mode;
      store.setLineNumbers({
        enabled: !alreadyActive,
        mode,
        countBy: current?.countBy,
      });
    },
  })),
  {
    id: 'zoomIn',
    title: 'Zoom In',
    icon: ZoomIn,
    group: 'navigate',
    keywords: ['zoom', 'in', 'magnify', 'bigger', 'larger'],
    run: () => cfg().setZoomLevel(cfg().config.editor.zoomLevel + 10),
  },
  {
    id: 'zoomOut',
    title: 'Zoom Out',
    icon: ZoomOut,
    group: 'navigate',
    keywords: ['zoom', 'out', 'shrink', 'smaller'],
    run: () => cfg().setZoomLevel(cfg().config.editor.zoomLevel - 10),
  },
  {
    id: 'zoomReset',
    title: 'Reset Zoom to 100%',
    icon: Maximize,
    group: 'navigate',
    keywords: ['zoom', 'reset', '100', 'normal', 'default'],
    run: () => cfg().setZoomLevel(100),
  },

  // ── Format (editor-context commands — shared ShortcutsExtension
  //    dispatch path; the palette never re-implements one) ──────────
  editorCommand('bold', {
    title: 'Bold',
    icon: Bold,
    group: 'format',
    shortcutId: 'bold',
    keywords: ['bold', 'b', 'format', 'strong'],
  }),
  editorCommand('italic', {
    title: 'Italic',
    icon: Italic,
    group: 'format',
    shortcutId: 'italic',
    keywords: ['italic', 'i', 'format', 'emphasis'],
  }),
  editorCommand('underline', {
    title: 'Underline',
    icon: UnderlineIcon,
    group: 'format',
    shortcutId: 'underline',
    keywords: ['underline', 'u', 'format'],
  }),
  editorCommand('strike', {
    title: 'Strikethrough',
    icon: Strikethrough,
    group: 'format',
    shortcutId: 'strike',
    keywords: ['strikethrough', 'strike', 'cross out', 'format'],
  }),
  editorCommand('clearFormatting', {
    title: 'Clear Formatting',
    icon: RemoveFormatting,
    group: 'format',
    shortcutId: 'clearFormatting',
    keywords: ['clear', 'remove', 'formatting', 'plain', 'reset'],
  }),
  editorCommand('fontSizeUp', {
    title: 'Increase Font Size',
    icon: CaseSensitive,
    group: 'format',
    shortcutId: 'fontSizeUp',
    keywords: ['font', 'size', 'grow', 'bigger', 'larger'],
  }),
  editorCommand('fontSizeDown', {
    title: 'Decrease Font Size',
    icon: CaseSensitive,
    group: 'format',
    shortcutId: 'fontSizeDown',
    keywords: ['font', 'size', 'shrink', 'smaller'],
  }),
  editorCommand('insertPageBreak', {
    title: 'Insert Page Break',
    icon: SeparatorHorizontal,
    group: 'format',
    shortcutId: 'insertPageBreak',
    keywords: ['page', 'break', 'insert', 'new page'],
  }),
  editorCommand('insertSectionBreak', {
    title: 'Insert Section Break',
    icon: SeparatorHorizontal,
    group: 'format',
    shortcutId: 'insertSectionBreak',
    keywords: ['section', 'break', 'insert', 'new section'],
  }),
  // #74 COLUMNS — the manual column break (the page break's twin;
  // the ribbon button + the palette + a choosable shortcut).
  editorCommand('insertColumnBreak', {
    title: 'Insert Column Break',
    icon: SeparatorHorizontal,
    group: 'format',
    shortcutId: 'insertColumnBreak',
    keywords: ['column', 'break', 'insert', 'columns'],
  }),
  editorCommand('insertLink', {
    title: 'Insert Hyperlink',
    icon: Link2,
    group: 'format',
    shortcutId: 'insertLink',
    keywords: ['link', 'hyperlink', 'url', 'insert'],
  }),
  editorCommand('insertEquation', {
    title: 'Insert Equation',
    icon: Sigma,
    group: 'format',
    shortcutId: 'insertEquation',
    keywords: ['equation', 'formula', 'math', 'latex', 'insert', 'sigma'],
  }),
  editorCommand('alignLeft', {
    title: 'Align Left',
    icon: AlignLeft,
    group: 'format',
    shortcutId: 'alignLeft',
    keywords: ['align', 'left', 'justify'],
  }),
  editorCommand('alignCenter', {
    title: 'Align Center',
    icon: AlignCenter,
    group: 'format',
    shortcutId: 'alignCenter',
    keywords: ['align', 'center', 'middle'],
  }),
  editorCommand('alignRight', {
    title: 'Align Right',
    icon: AlignRight,
    group: 'format',
    shortcutId: 'alignRight',
    keywords: ['align', 'right'],
  }),
  editorCommand('alignJustify', {
    title: 'Justify',
    icon: AlignJustify,
    group: 'format',
    shortcutId: 'alignJustify',
    keywords: ['align', 'justify', 'full'],
  }),
  editorCommand('unorderedList', {
    title: 'Bullet List',
    icon: List,
    group: 'format',
    shortcutId: 'unorderedList',
    keywords: ['bullet', 'list', 'unordered', 'ul'],
  }),
  editorCommand('orderedList', {
    title: 'Numbered List',
    icon: ListOrdered,
    group: 'format',
    shortcutId: 'orderedList',
    keywords: ['numbered', 'list', 'ordered', 'ol'],
  }),
  editorCommand('increaseIndent', {
    title: 'Increase Indent',
    icon: IndentIncrease,
    group: 'format',
    shortcutId: 'increaseIndent',
    keywords: ['indent', 'increase', 'more', 'tab'],
  }),
  editorCommand('decreaseIndent', {
    title: 'Decrease Indent',
    icon: IndentDecrease,
    group: 'format',
    shortcutId: 'decreaseIndent',
    keywords: ['indent', 'decrease', 'less', 'outdent'],
  }),
  editorCommand('applyStyleNormal', {
    title: 'Apply Normal Text Style',
    icon: Pilcrow,
    group: 'format',
    keywords: ['style', 'normal', 'body', 'apply'],
  }),
  editorCommand('applyStyleHeading1', {
    title: 'Apply Heading 1 Style',
    icon: Heading1,
    group: 'format',
    keywords: ['style', 'heading', 'title', 'h1', 'apply'],
  }),
  editorCommand('applyStyleHeading2', {
    title: 'Apply Heading 2 Style',
    icon: Heading2,
    group: 'format',
    keywords: ['style', 'heading', 'h2', 'apply'],
  }),
  editorCommand('applyStyleHeading3', {
    title: 'Apply Heading 3 Style',
    icon: Heading3,
    group: 'format',
    keywords: ['style', 'heading', 'h3', 'apply'],
  }),
  editorCommand('applyStyleQuote', {
    title: 'Apply Quote Style',
    icon: Quote,
    group: 'format',
    keywords: ['style', 'quote', 'blockquote', 'apply'],
  }),
];

/**
 * M-IMAGES-1.5 — direct radius entry (the toolbar's input): the SAME
 * clamp law the stepper commands enforce (half the min dim), written
 * through the SAME attr path. Returns the CLAMPED value actually
 * written (or null when no image is selected) so the input can
 * re-display the truth.
 */
export function setImageRadiusOnSelection(value: number): number | null {
  const sel = selectedImageRef();
  if (!sel) return null;
  const clamped = clampRadiusRef(Number.isFinite(value) ? Math.round(value) : 0, sel.attrs);
  writeImageAttrsRef({ radius: clamped });
  return clamped;
}

export function getCommand(id: string): CommandAction | undefined {
  return COMMANDS.find((c) => c.id === id);
}

export function getCommandByMenuEvent(menuEventId: string): CommandAction | undefined {
  return COMMANDS.find((c) => c.menuEventId === menuEventId);
}
