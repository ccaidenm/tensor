import { useEffect, useRef, useState } from "react";
import { EditorContent, type Editor } from "@tiptap/react";
import { useLinkBubble } from "@/lib/editor/useLinkBubble";
import { LinkBubble } from "./LinkBubble";
import { useEquationEditor } from "@/lib/editor/useEquationEditor";
import { EquationEditorBubble } from "./EquationEditorBubble";
import { TooltipProvider } from "../ui/tooltip";
import { useConfigStore } from "@/lib/config/store";
import { useDocumentStore } from "@/lib/document/store";
import { ptToPx } from "@/lib/document/pageSetup";
import { FloatingToolbar } from "./FloatingToolbar";
import { useFloatingToolbar } from "@/lib/editor/useFloatingToolbar";
import { applyRightClickSelection } from "@/lib/editor/rightClickSelection";
import { SpellBubble } from "./SpellBubble";
import { getSpellErrors } from "@/lib/editor/spell/SpellExtension";
import type { SpellError } from "@/lib/editor/spell/types";

interface PagelessEditorProps {
  editor: Editor | null;
  fontFamily: string;
  fontSize: number;
}

export function PagelessEditor({ editor, fontFamily, fontSize }: PagelessEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const linkBubbleRef = useRef<HTMLDivElement>(null);
  const linkBubble = useLinkBubble(editor, linkBubbleRef);
  // M-EQ: the equation editor bubble — same chrome spot as the link
  // bubble (anchored to the clicked node view's DOM box; pageless has
  // no painted-rect projection).
  const equationBubbleRef = useRef<HTMLDivElement>(null);
  const { state: equationState, close: closeEquationEditor } = useEquationEditor(editor, equationBubbleRef);
  const showNonPrintingChars = useConfigStore((s) => s.config.editor.showNonPrintingChars);
  const zoomLevel = useConfigStore((s) => s.config.editor.zoomLevel);
  const showFloatingToolbar = useConfigStore((s) => s.config.useFloatingToolbar);
  const floatingToolbarPosition = useFloatingToolbar(editor, showFloatingToolbar);
  // One setting, two surfaces (M6.1 carryover): the document's page
  // background paints the paginated SHEETS and this pageless editing
  // SURFACE alike. Absent ('') = no background style.
  const pageColor = useDocumentStore((s) => s.pageSetup.pageColor);
  // THE STRIP (the pageless law): real margins from the DOCUMENT's
  // pageSetup (pt → px — the same margins the paginated view's sheets
  // use, so one margin concept per document, ruled by the Page Setup
  // dialog), a responsive max-width column (GDocs-pageless style), and
  // the document's page color painting the strip (WHITE default — the
  // strip is the page now; the desk stays muted behind it).
  const margins = useDocumentStore((s) => s.pageSetup.margins);
  // FULL HEIGHT (the sheet law): the strip fills the desk's visible
  // height — GDocs-pageless posture, the white sheet never ends. The
  // desk scroller's height minus its pt-8/pb-6 breathing room, divided
  // by the zoom (the strip lives inside the zoom transform — the layout
  // height must undo it so the RENDERED strip fills the desk). jsdom's
  // zero-height client floors at 200.
  const [deskHeight, setDeskHeight] = useState(0);
  useEffect(() => {
    const scroller = document.querySelector('[data-desk-scroll]');
    const measure = () => setDeskHeight((scroller as HTMLElement | null)?.clientHeight ?? 0);
    measure();
    const ro = new ResizeObserver(measure);
    if (scroller) ro.observe(scroller);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  const stripMinHeight = Math.max(200, (deskHeight - 56) / (zoomLevel / 100));
  // Accessibility: the double-line container class (the descendant CSS
  // rule flips grammar decorations to text-decoration-style: double —
  // live, without rebuilding the decoration set).
  const grammarDoubleLine = useConfigStore((s) => s.config.accessibility.grammarDoubleLine);

  // The suggestion bubble (GDocs rule: plain click on a flagged word).
  // The anchor stores the OPEN-TIME offset from the container — the
  // pageless surface has no painted-rect projection to re-derive from.
  const [spellBubble, setSpellBubble] = useState<{ error: SpellError; left: number; top: number } | null>(null);
  // Typing invalidates the anchored word.
  useEffect(() => {
    if (!editor) return;
    const close = () => setSpellBubble(null);
    editor.on("update", close);
    return () => {
      editor.off("update", close);
    };
  }, [editor]);

  /** A plain click on a flagged span (the decoration's DOM span — the
   *  pageless surface IS the PM view) opens the suggestion bubble.
   *  Spelling AND grammar spans are both flagged spans. The span's
   *  text identifies the error (the plugin's drop-guard keeps span
   *  text == word by construction — no posAtCoords needed). The
   *  click-outside/Escape dismissal lives on the bubble itself. */
  function handleSpellClick(e: React.MouseEvent) {
    if (!editor) return;
    const span = (e.target as HTMLElement).closest(".tensor-spell-error, .tensor-grammar-error");
    if (!span) return;
    const word = span.textContent ?? "";
    const error = getSpellErrors(editor.state).find((x) => x.word === word);
    if (!error) return;
    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;
    const spanRect = span.getBoundingClientRect();
    setSpellBubble({ error, left: spanRect.left - containerRect.left, top: spanRect.bottom - containerRect.top + 4 });
  }

  /** M-T4 — the pageless arm of the right-click rule
   *  (rightClickSelection.ts), on the CONTEXTMENU event: PM ignores
   *  non-primary buttons, so a right-click here never moved the caret
   *  and the menu read the STALE selection — including the
   *  menu-already-open case, where the dismissal swallows the mousedown
   *  but the native contextmenu still fires. This handler sits DEEPER
   *  than the menu trigger, so it runs before the trigger's own
   *  handler (base-ui stopEvent's it) and the re-opened menu reads the
   *  click-resolved selection. */
  function handleContextMenu(e: React.MouseEvent) {
    if (!editor || e.button !== 2) return;
    // Coordinate-less dispatches (tests, keyboard-invoked menus): the
    // selection stays wherever its owner put it.
    if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
    const coords = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
    applyRightClickSelection(editor, coords ? coords.pos : null);
  }

  return (
    <TooltipProvider>
      {/* The bubble mounts OUTSIDE the zoom transform (chrome at 100%
          — the paginated FloatingToolbar law); the inner container
          keeps the scale and the original structure. */}
      <div className="relative">
        <div
          ref={containerRef}
          className="relative"
          style={{
            transform: `scale(${zoomLevel / 100})`,
            transformOrigin: 'top center',
          }}
          onContextMenu={handleContextMenu}
          onClick={handleSpellClick}
        >
          {/* THE STRIP — the continuous sheet: centered responsive
              column (max-width, shrinks on narrow windows), the
              document's margins as padding, the document's page color
              (WHITE default) as the sheet, a shadow to lift it off
              the muted desk. THE PAGE, infinitely tall. */}
          <div
            data-testid="pageless-surface"
            className={`pageless-strip relative z-10 mx-auto ${showNonPrintingChars ? "show-non-printing" : ""} ${grammarDoubleLine ? "grammar-double-line" : ""}`}
            style={{
              background: pageColor || '#ffffff',
              maxWidth: 960,
              minHeight: stripMinHeight,
              padding: `${ptToPx(margins.top)}px ${ptToPx(margins.right)}px ${ptToPx(margins.bottom)}px ${ptToPx(margins.left)}px`,
            }}
          >
            <EditorContent
              editor={editor}
              className="prose prose-neutral min-h-100 focus:outline-none text-black"
              style={{ fontFamily, fontSize: `${fontSize}px` }}
            />
          </div>

          {linkBubble && editor && containerRef.current && (
            <LinkBubble
              ref={linkBubbleRef}
              editor={editor}
              bubble={linkBubble}
              containerTop={containerRef.current.getBoundingClientRect().top}
              containerLeft={containerRef.current.getBoundingClientRect().left}
            />
          )}

          {/* M-EQ: body-portal + fixed inside the component (escapes
              the zoomed container and the scroll clip — drag-safe over
              the ribbon); the pageless DOM anchor derives at render. */}
          {equationState && editor && (
            <EquationEditorBubble
              ref={equationBubbleRef}
              editor={editor}
              state={equationState}
              onClose={closeEquationEditor}
            />
          )}

          {floatingToolbarPosition && editor && containerRef.current && (
            <FloatingToolbar
              editor={editor}
              position={floatingToolbarPosition}
              containerTop={containerRef.current.getBoundingClientRect().top}
              containerLeft={containerRef.current.getBoundingClientRect().left}
            />
          )}
        </div>

        {spellBubble && editor && (
          <SpellBubble
            editor={editor}
            error={spellBubble.error}
            left={spellBubble.left}
            top={spellBubble.top}
            onClose={() => setSpellBubble(null)}
          />
        )}
      </div>

    </TooltipProvider>
  );
}
