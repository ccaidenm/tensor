import type { LineBox, Rect } from '@tensor-editor/engine';

/**
 * Pure projection from LayoutResult LineBox rects — computes nothing;
 * inside the zoom transform (pre-zoom px, no scale compensation).
 * pointer-events: none so margin clicks reach the sheet's nearest-line
 * handling (hitTest.ts).
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
  /** Content-relative y-offsets (the shared key with the icon layers) of
   *  lines whose number yields its slot to a contextual gutter element
   *  (ref badge, pin, bookmark) — icon in place, never both. */
  suppressed?: ReadonlySet<number>;
  /** The document's baseStyle font (resolveNormalBase). */
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
            // The number gives way to the contextual icon.
            ...(suppressed?.has(line.rect.y) ? { visibility: 'hidden' } : {}),
          }}
        >
          {number}
        </div>
      ))}
    </div>
  );
}
