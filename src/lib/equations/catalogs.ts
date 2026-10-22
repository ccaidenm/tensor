/**
 * M-EQ-0 — the assisted-input catalogs (the issue's "some
 * assisted/visual input path" ruling): the equation editor popover
 * renders THESE, never a raw-LaTeX-only entry path. Shapes mirror the
 * symbols.ts catalog convention (name-tagged entries, category groups)
 * so the SymbolButton and EquationButton popovers read identically.
 *
 * Entries carry LATEX SOURCE, not unicode glyphs — the palette buttons
 * render each entry through KaTeX (renderInlineMath), so what the user
 * clicks is exactly what the document gets.
 */

export interface MathSymbolEntry {
  /** LaTeX source inserted into the equation when clicked. */
  latex: string;
  name: string;
}

export interface MathTemplate {
  label: string;
  /** LaTeX skeleton inserted verbatim — the user fills the arguments. */
  latex: string;
  name: string;
  /** M-EQ-2: the MathLive WYSIWYG insertion form — `#@` = the current
   *  selection (or nothing), `#?` = a placeholder the CARET lands in
   *  (Tab hops slots): clicking the tile inserts the STRUCTURE into the
   *  math field and the user edits it inline, never seeing LaTeX.
   *  Absent = insert the plain `latex` form. */
  mf?: string;
}

export const MATH_SYMBOLS: Record<string, MathSymbolEntry[]> = {
  'Greek lowercase': [
    { latex: '\\alpha', name: 'alpha' }, { latex: '\\beta', name: 'beta' },
    { latex: '\\gamma', name: 'gamma' }, { latex: '\\delta', name: 'delta' },
    { latex: '\\epsilon', name: 'epsilon' }, { latex: '\\varepsilon', name: 'varepsilon' },
    { latex: '\\zeta', name: 'zeta' }, { latex: '\\eta', name: 'eta' },
    { latex: '\\theta', name: 'theta' }, { latex: '\\vartheta', name: 'vartheta' },
    { latex: '\\iota', name: 'iota' }, { latex: '\\kappa', name: 'kappa' },
    { latex: '\\lambda', name: 'lambda' }, { latex: '\\mu', name: 'mu' },
    { latex: '\\nu', name: 'nu' }, { latex: '\\xi', name: 'xi' },
    { latex: '\\pi', name: 'pi' }, { latex: '\\rho', name: 'rho' },
    { latex: '\\sigma', name: 'sigma' }, { latex: '\\tau', name: 'tau' },
    { latex: '\\upsilon', name: 'upsilon' }, { latex: '\\phi', name: 'phi' },
    { latex: '\\varphi', name: 'varphi' }, { latex: '\\chi', name: 'chi' },
    { latex: '\\psi', name: 'psi' }, { latex: '\\omega', name: 'omega' },
  ],
  'Greek uppercase': [
    { latex: '\\Gamma', name: 'Gamma' }, { latex: '\\Delta', name: 'Delta' },
    { latex: '\\Theta', name: 'Theta' }, { latex: '\\Lambda', name: 'Lambda' },
    { latex: '\\Xi', name: 'Xi' }, { latex: '\\Pi', name: 'Pi' },
    { latex: '\\Sigma', name: 'Sigma' }, { latex: '\\Upsilon', name: 'Upsilon' },
    { latex: '\\Phi', name: 'Phi' }, { latex: '\\Psi', name: 'Psi' },
    { latex: '\\Omega', name: 'Omega' },
  ],
  Operators: [
    { latex: '\\pm', name: 'plus minus' }, { latex: '\\mp', name: 'minus plus' },
    { latex: '\\times', name: 'times' }, { latex: '\\div', name: 'divide' },
    { latex: '\\cdot', name: 'dot multiply' }, { latex: '\\ast', name: 'asterisk' },
    { latex: '\\star', name: 'star' }, { latex: '\\circ', name: 'circle compose' },
    { latex: '\\bullet', name: 'bullet' }, { latex: '\\oplus', name: 'circled plus' },
    { latex: '\\ominus', name: 'circled minus' }, { latex: '\\otimes', name: 'circled times' },
    { latex: '\\oslash', name: 'circled divide' }, { latex: '\\odot', name: 'circled dot' },
    { latex: '\\dagger', name: 'dagger' }, { latex: '\\bigtriangleup', name: 'big triangle up' },
    { latex: '\\triangleleft', name: 'triangle left' }, { latex: '\\trianglelefteq', name: 'triangle left or equal' },
  ],
  Relations: [
    { latex: '<', name: 'less than' }, { latex: '>', name: 'greater than' },
    { latex: '\\leq', name: 'less than or equal' }, { latex: '\\geq', name: 'greater than or equal' },
    { latex: '\\neq', name: 'not equal' }, { latex: '\\approx', name: 'approximately' },
    { latex: '\\equiv', name: 'equivalent' }, { latex: '\\sim', name: 'similar' },
    { latex: '\\simeq', name: 'similar equal' }, { latex: '\\cong', name: 'congruent' },
    { latex: '\\propto', name: 'proportional' }, { latex: '\\ll', name: 'much less' },
    { latex: '\\gg', name: 'much greater' }, { latex: '\\parallel', name: 'parallel' },
    { latex: '\\perp', name: 'perpendicular' },
  ],
  Sets: [
    { latex: '\\in', name: 'element of' }, { latex: '\\notin', name: 'not element of' },
    { latex: '\\ni', name: 'contains element' }, { latex: '\\subset', name: 'subset' },
    { latex: '\\subseteq', name: 'subset or equal' }, { latex: '\\supset', name: 'superset' },
    { latex: '\\supseteq', name: 'superset or equal' }, { latex: '\\cup', name: 'union' },
    { latex: '\\cap', name: 'intersection' }, { latex: '\\emptyset', name: 'empty set' },
    { latex: '\\varnothing', name: 'nothing set' }, { latex: '\\setminus', name: 'set minus' },
    { latex: '\\mathbb{R}', name: 'real numbers' }, { latex: '\\mathbb{N}', name: 'natural numbers' },
    { latex: '\\mathbb{Z}', name: 'integers' }, { latex: '\\mathbb{Q}', name: 'rationals' },
    { latex: '\\mathbb{C}', name: 'complex numbers' },
  ],
  Logic: [
    { latex: '\\forall', name: 'for all' }, { latex: '\\exists', name: 'exists' },
    { latex: '\\nexists', name: 'not exists' }, { latex: '\\neg', name: 'logical not' },
    { latex: '\\land', name: 'logical and' }, { latex: '\\lor', name: 'logical or' },
    { latex: '\\implies', name: 'implies' }, { latex: '\\iff', name: 'if and only if' },
    { latex: '\\vdash', name: 'turnstile' }, { latex: '\\models', name: 'models' },
    { latex: '\\therefore', name: 'therefore' }, { latex: '\\because', name: 'because' },
  ],
  Arrows: [
    { latex: '\\rightarrow', name: 'right arrow' }, { latex: '\\leftarrow', name: 'left arrow' },
    { latex: '\\leftrightarrow', name: 'left right arrow' }, { latex: '\\Rightarrow', name: 'double right arrow' },
    { latex: '\\Leftarrow', name: 'double left arrow' }, { latex: '\\Leftrightarrow', name: 'double left right arrow' },
    { latex: '\\mapsto', name: 'maps to' }, { latex: '\\to', name: 'to' },
    { latex: '\\uparrow', name: 'up arrow' }, { latex: '\\downarrow', name: 'down arrow' },
    { latex: '\\updownarrow', name: 'up down arrow' }, { latex: '\\nearrow', name: 'north east arrow' },
  ],
  Calculus: [
    { latex: '\\partial', name: 'partial' }, { latex: '\\nabla', name: 'nabla gradient' },
    { latex: '\\infty', name: 'infinity' }, { latex: '\\int', name: 'integral' },
    { latex: '\\oint', name: 'contour integral' }, { latex: '\\sum', name: 'summation' },
    { latex: '\\prod', name: 'product' }, { latex: '\\bigcup', name: 'big union' },
    { latex: '\\bigcap', name: 'big intersection' }, { latex: '\\lim', name: 'limit' },
    { latex: '\\sup', name: 'supremum' }, { latex: '\\inf', name: 'infimum' },
    { latex: '\\max', name: 'maximum' }, { latex: '\\min', name: 'minimum' },
  ],
  Accents: [
    { latex: "\\hat{x}", name: 'hat' }, { latex: "\\bar{x}", name: 'bar' },
    { latex: "\\tilde{x}", name: 'tilde' }, { latex: "\\dot{x}", name: 'dot' },
    { latex: "\\ddot{x}", name: 'double dot' }, { latex: "\\vec{x}", name: 'vector' },
    { latex: "\\overline{x}", name: 'overline' }, { latex: "\\underline{x}", name: 'underline' },
    { latex: "\\widehat{xy}", name: 'wide hat' }, { latex: "\\widetilde{xy}", name: 'wide tilde' },
  ],
};

export const MATH_TEMPLATES: { category: string; templates: MathTemplate[] }[] = [
  {
    category: 'Layout',
    templates: [
      { label: 'Fraction', latex: '\\frac{a}{b}', mf: '\\frac{#@}{#?}', name: 'fraction' },
      { label: 'Small frac', latex: '\\tfrac{a}{b}', mf: '\\tfrac{#@}{#?}', name: 'small fraction' },
      { label: 'Binomial', latex: '\\binom{n}{k}', mf: '\\binom{#@}{#?}', name: 'binomial coefficient' },
      { label: 'Square root', latex: '\\sqrt{x}', mf: '\\sqrt{#@}', name: 'square root' },
      { label: 'nth root', latex: '\\sqrt[n]{x}', mf: '\\sqrt[#?]{#@}', name: 'nth root' },
      { label: 'Absolute value', latex: '|x|', mf: '\\left|#@\\right|', name: 'absolute value' },
      { label: 'Norm', latex: '\\|x\\|', mf: '\\left\\|#@\\right\\|', name: 'norm' },
      { label: 'Parens', latex: '(x)', mf: '\\left(#@\\right)', name: 'parentheses' },
      { label: 'Brackets', latex: '[x]', mf: '\\left[#@\\right]', name: 'brackets' },
      { label: 'Braces', latex: '\\{x\\}', mf: '\\left\\{#@\\right\\}', name: 'braces' },
      { label: 'Angle brackets', latex: '\\langle x \\rangle', mf: '\\left\\langle #@ \\right\\rangle', name: 'angle brackets' },
      { label: 'Floor', latex: '\\lfloor x \\rfloor', mf: '\\left\\lfloor #@ \\right\\rfloor', name: 'floor' },
      { label: 'Ceiling', latex: '\\lceil x \\rceil', mf: '\\left\\lceil #@ \\right\\rceil', name: 'ceiling' },
    ],
  },
  {
    category: 'Scripts',
    templates: [
      { label: 'Superscript', latex: 'x^{2}', mf: '#@^{#?}', name: 'superscript power' },
      { label: 'Subscript', latex: 'x_{i}', mf: '#@_{#?}', name: 'subscript index' },
      { label: 'Sub + super', latex: 'x_{i}^{2}', mf: '#@_{#?}^{#?}', name: 'subscript and superscript' },
      { label: 'Prime', latex: "x'", mf: "#@'", name: 'prime derivative' },
      { label: 'Overline', latex: '\\overline{AB}', mf: '\\overline{#@}', name: 'overline segment' },
      { label: 'Underbrace', latex: '\\underbrace{x}_{\\text{note}}', mf: '\\underbrace{#@}_{#?}', name: 'underbrace' },
      { label: 'Stackrel', latex: '\\stackrel{\\text{def}}{=}', mf: '\\stackrel{#?}{=}', name: 'stacked relation' },
      { label: 'Phantom', latex: '\\phantom{x}', mf: '\\phantom{#@}', name: 'phantom space' },
    ],
  },
  {
    category: 'Calculus',
    templates: [
      { label: 'Integral', latex: '\\int_{a}^{b} f(x)\\,dx', mf: '\\int_{#?}^{#?} #@\\,dx', name: 'definite integral' },
      { label: 'Indef integral', latex: '\\int f(x)\\,dx', mf: '\\int #@\\,dx', name: 'indefinite integral' },
      { label: 'Double integral', latex: '\\iint_{D} f\\,dA', mf: '\\iint_{#?} #@\\,dA', name: 'double integral' },
      { label: 'Contour', latex: '\\oint_{C} \\mathbf{F}\\cdot d\\mathbf{r}', mf: '\\oint_{#?} #@\\,d\\mathbf{r}', name: 'contour integral' },
      { label: 'Sum', latex: '\\sum_{i=1}^{n} a_{i}', mf: '\\sum_{#?}^{#?} #@', name: 'summation' },
      { label: 'Product', latex: '\\prod_{i=1}^{n} a_{i}', mf: '\\prod_{#?}^{#?} #@', name: 'product' },
      { label: 'Limit', latex: '\\lim_{x \\to \\infty} f(x)', mf: '\\lim_{#?} #@', name: 'limit' },
      { label: 'Derivative', latex: '\\frac{d}{dx}f(x)', mf: '\\frac{d}{dx} #@', name: 'derivative' },
      { label: 'Partial', latex: '\\frac{\\partial f}{\\partial x}', mf: '\\frac{\\partial #@}{\\partial #?}', name: 'partial derivative' },
    ],
  },
  {
    category: 'Matrices',
    templates: [
      { label: '2×2 matrix', latex: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', mf: '\\begin{pmatrix}#@ & #? \\\\ #? & #?\\end{pmatrix}', name: 'parenthesis matrix' },
      { label: 'Bracket matrix', latex: '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}', mf: '\\begin{bmatrix}#@ & #? \\\\ #? & #?\\end{bmatrix}', name: 'bracket matrix' },
      { label: 'Determinant', latex: '\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}', mf: '\\begin{vmatrix}#@ & #? \\\\ #? & #?\\end{vmatrix}', name: 'determinant' },
      { label: 'Cases', latex: '\\begin{cases} x \\quad \\text{if } x > 0 \\\\ 0 \\quad \\text{otherwise} \\end{cases}', mf: '\\begin{cases}#@ & #? \\\\ #? & #?\\end{cases}', name: 'cases piecewise' },
      { label: 'Aligned', latex: '\\begin{aligned} f(x) &= x^{2} \\\\ g(x) &= x^{3} \\end{aligned}', mf: '\\begin{aligned}#@ &= #? \\\\ #? &= #?\\end{aligned}', name: 'aligned equations' },
    ],
  },
  {
    category: 'Text & decoration',
    templates: [
      { label: 'Text', latex: '\\text{where}', mf: '\\text{#@}', name: 'text in math' },
      { label: 'Bold', latex: '\\mathbf{v}', mf: '\\mathbf{#@}', name: 'bold vector' },
      { label: 'Blackboard', latex: '\\mathbb{R}', mf: '\\mathbb{#?}', name: 'blackboard bold' },
      { label: 'Calligraphic', latex: '\\mathcal{F}', mf: '\\mathcal{#?}', name: 'calligraphic' },
      { label: 'Fraktur', latex: '\\mathfrak{g}', mf: '\\mathfrak{#?}', name: 'fraktur' },
      { label: 'Boxed', latex: '\\boxed{E=mc^{2}}', mf: '\\boxed{#@}', name: 'boxed equation' },
      { label: 'Space', latex: '\\quad', name: 'quad space' },
      { label: 'Thin space', latex: '\\,', name: 'thin space' },
    ],
  },
];