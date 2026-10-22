import { useEffect, useRef, useState } from "react";
import { EditorContent, type Editor } from "@tiptap/react";
import { useLinkBubble } from "@/lib/editor/useLinkBubble";
import { LinkBubble } from "./LinkBubble";
import { TooltipProvider } from "../ui/tooltip";
import { useConfigStore } from "@/lib/config/store";
import { useDocumentStore } from "@/lib/document/store";
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
  const showNonPrintingChars = useConfigStore((s) => s.config.editor.showNonPrintingChars);
  const zoomLevel = useConfigStore((s) => s.config.editor.zoomLevel);
  const showFloatingToolbar = useConfigStore((s) => s.config.useFloatingToolbar);
  const floatingToolbarPosition = useFloatingToolbar(editor, showFloatingToolbar);
  // One setting, two surfaces (M6.1 carryover): the document's page
  // background paints the paginated SHEETS and this pageless editing
  // SURFACE alike. Absent ('') = no background style.
  const pageColor = useDocumentStore((s) => s.pageSetup.pageColor);
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
          className="relative mx-auto"
          style={{
            transform: `scale(${zoomLevel / 100})`,
            transformOrigin: 'top center',
          }}
          onContextMenu={handleContextMenu}
          onClick={handleSpellClick}
        >
          <div
            data-testid="pageless-surface"
            className={`relative z-10 ${showNonPrintingChars ? "show-non-printing" : ""} ${grammarDoubleLine ? "grammar-double-line" : ""}`}
            style={{ ...(pageColor ? { background: pageColor } : {}) }}
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
