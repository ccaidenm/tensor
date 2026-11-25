import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { parseEquation, renderEquation } from '@/lib/equations/render';

/**
 * The equation node view: KaTeX HTML of the node's latex attr
 * (renderEquation is the one render surface). In paginated mode it
 * renders invisibly (opacity 0, NOT aria-hidden): KaTeX's
 * 'htmlAndMathml' output carries a visually-hidden MathML copy, keeping
 * the formula in the a11y tree. Never KaTeX's red error text — an empty
 * equation renders the dashed placeholder, an invalid one its source
 * in the invalid face.
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
      // Alignment: the engine reads the same attr (one derivation);
      // flex justify positions the shrink-wrapped math box. Color is
      // paint-only; null inherits the container's text color.
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
          // KaTeX HTML from this node's latex — display-only, never persisted.
          dangerouslySetInnerHTML={{ __html: renderEquation(latex) }}
        />
      )}
    </NodeViewWrapper>
  );
}