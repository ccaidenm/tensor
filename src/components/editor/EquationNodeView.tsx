import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { parseEquation, renderEquation } from '@/lib/equations/render';

/**
 * M-EQ — the equation node view. The visible rendering in PAGELESS
 * mode (KaTeX HTML projected from the node's latex attr — the ONE
 * render surface, lib/equations/render.ts). In PAGINATED mode this
 * same view renders invisibly inside the hidden-input view (opacity 0,
 * NOT aria-hidden — the M5 a11y mirror): KaTeX's default
 * 'htmlAndMathml' output carries a visually-hidden MathML copy, so the
 * formula is in the accessibility tree exactly like the <img alt>
 * receipt.
 *
 * THE BROKEN-GLYPH LAW (the image family's): the document never shows
 * KaTeX's red error text or a silent empty box. An EMPTY equation
 * renders the dashed placeholder (it is a just-inserted equation
 * awaiting input); an INVALID one renders its source in a styled
 * invalid face — the edit path (the popover) is always one click away,
 * and the popover's own validation surfaces the ParseError message.
 */

type EquationNodeViewProps = ReactNodeViewProps;

export function EquationNodeView({ node, selected }: EquationNodeViewProps) {
  const { latex, align, color } = node.attrs as {
    latex: string;
    align: 'left' | 'center' | 'right';
    color: string | null;
  };

  const empty = latex.trim() === '';
  const parseError = empty ? null : parseEquation(latex);

  return (
    <NodeViewWrapper
      data-equation-node="true"
      data-resolved={empty ? 'empty' : parseError ? 'invalid' : 'ok'}
      // Alignment is the node's attr (the engine reads the same attr —
      // one derivation): flex justify positions the shrink-wrapped
      // math box. Color: the node's paint-only attr; null INHERITS the
      // container (the pageless container carries the document's
      // default text color — text-black plus the StylesStylesheet's
      // normal-style override when one exists).
      style={{
        justifyContent: align === 'right' ? 'flex-end' : align === 'left' ? 'flex-start' : 'center',
        ...(color ? { color } : {}),
      }}
      className={`tensor-equation tensor-equation-wrapper ${selected ? 'tensor-equation-selected' : ''}`}
    >
      {empty ? (
        <div
          data-testid="equation-placeholder"
          role="math"
          aria-label="Empty equation"
          className="tensor-equation-placeholder"
        />
      ) : parseError ? (
        <div
          data-testid="equation-invalid"
          role="math"
          aria-label={`Invalid equation: ${latex}`}
          className="tensor-equation-invalid"
        >
          <code>{latex}</code>
        </div>
      ) : (
        <div
          data-testid="equation-render"
          role="math"
          className="tensor-equation-math"
          // KaTeX's output — generated HTML from THIS node's latex, the
          // display-only projection (never persisted anywhere).
          dangerouslySetInnerHTML={{ __html: renderEquation(latex) }}
        />
      )}
    </NodeViewWrapper>
  );
}