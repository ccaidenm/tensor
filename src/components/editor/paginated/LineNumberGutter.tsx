import type { LineBox, Rect } from '@tensor-editor/engine';

/**
 * M-LINENUMS — the left-margin gutter, pure projection. Derives
 * ONLY from LayoutResult facts (LineBox rects) + the document's
 * setting; computes nothing. It is overlay chrome over the sheet:
 * pointer-events NONE, so margin clicks fall straight through to
 * the sheet's existing nearest-line handling (hitTest.ts — the M5
 * legacy fixtures own that behavior, not this file).
 *
 * Lives INSIDE the zoom transform (a child of the scaled stack, like
 * every painted element): positions are logical pre-zoom px and
 * NOTHING here compensates for scale.
 */

interface GutterEntry {
  line: LineBox;
  /** Aligned countLineNumbers() output; null never reaches here. */
  number: number;
}

interface LineNumberGutterProps {
  /** Page content box (logical px) — contentBox.x IS the left margin. */
  contentBox: Rect;
  entries: GutterEntry[];
  /**
   * M-GUTTER — CONTEXTUAL REPLACEMENT: the y-offsets (content-
   * relative, the shared key with the icon layers) of lines whose
   * number YIELDS its slot to a contextual gutter element (a ref-
   * table badge, a table-header pin, an index bookmark). The icon
   * renders IN the number's place; the number is hidden — never both.
   */
  suppressed?: ReadonlySet<number>;
  /** The document's baseStyle (resolveNormalBase) — the gutter speaks
   *  the document's font, at a muted, smaller voice. */
  fontFamily: string;
  fontSize: number;
}

export function LineNumberGutter({ contentBox, entries, suppressed, fontFamily, fontSize }: LineNumberGutterProps) {
  return (
    <div
      data-testid="line-number-gutter"
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 select-none text-right text-muted-foreground"
      style={{ width: `${contentBox.x}px`, height: '100%', fontFamily, fontSize: `${fontSize}px` }}
    >
      {entries.map(({ line, number }) => (
        <div
          key={`${line.blockId}:${line.lineIndex}`}
          data-testid={`line-number-${number}`}
          className="absolute"
          style={{
            top: `${contentBox.y + line.rect.y}px`,
            right: '8px',
            lineHeight: `${line.rect.height}px`,
            fontSize: `${Math.round(fontSize * 0.75)}px`,
            // M-GUTTER: the number gives way to the contextual icon.
            ...(suppressed?.has(line.rect.y) ? { visibility: 'hidden' } : {}),
          }}
        >
          {number}
        </div>
      ))}
    </div>
  );
}
