import { oKids, oSub, oat, type ONode } from './oxml';

/**
 * OMML → LaTeX (#38 import side): Word stores equations as OMML,
 * Tensor as LaTeX. Covers the constructs Word actually writes for
 * typed math; anything outside the subset degrades to its literal
 * text (never a silent loss — counted in the import report).
 */

interface OmmlState { degraded: number }

const text = (node: ONode | undefined): string => {
  if (!node) return '';
  let out = node.text;
  for (const kid of node.kids) out += text(kid);
  return out;
};

/** LaTeX specials inside math text: escape the delimiters Word never
 *  intends as grouping (they arrive as literal characters). */
function escapeMathText(value: string): string {
  return value.replace(/([\\{}$&#^_~%])/g, '\\$1');
}

const runText = (node: ONode | undefined): string =>
  oKids(node, 't').map((t) => escapeMathText(t.text)).join('');

/** m:acc's character → LaTeX accent. Word's default (no chr) is the hat. */
const ACCENTS: Record<string, string> = {
  '\u0302': '\\hat', '^': '\\hat',
  '\u0303': '\\tilde', '~': '\\tilde',
  '\u0307': '\\dot', '\u0308': '\\ddot',
  '\u0301': '\\acute', '\u0300': '\\grave',
  '\u0306': '\\breve', '\u030C': '\\check',
  '\u20D7': '\\vec',
  '\u2190': '\\overleftarrow', '\u2192': '\\overrightarrow',
  '\u23DE': '\\overbrace', '\u23DF': '\\underbrace',
  '\u0332': '\\underline', '\u0331': '\\underline',
};

/** m:nary's character → LaTeX operator (the common set Word offers). */
const NARY: Record<string, string> = {
  '\u2211': '\\sum', '\u220F': '\\prod', '\u222B': '\\int',
  '\u222C': '\\iint', '\u222D': '\\iiint', '\u222E': '\\oint',
  '\u22C0': '\\bigwedge', '\u22C1': '\\bigvee',
  '\u22C2': '\\bigcap', '\u22C3': '\\bigcup',
  '\u2210': '\\coprod',
};

const DELIMS: Record<string, string> = {
  '(': '(', ')': ')', '[': '[', ']': ']',
  '{': '\\{', '}': '\\}', '|': '|',
  '\u230A': '\\lfloor', '\u230B': '\\rfloor',
  '\u2308': '\\lceil', '\u2309': '\\rceil',
  '\u27E8': '\\langle', '\u27E9': '\\rangle',
};

export interface OmmlResult {
  latex: string;
  degraded: number;
}

/** Convert one m:oMath subtree. Returns the LaTeX, plus a degraded
 *  count for constructs outside the supported subset. */
export function ommlToLatex(oMath: ONode): OmmlResult {
  const state: OmmlState = { degraded: 0 };
  const latex = convertKids(oMath, state).trim();
  return { latex, degraded: state.degraded };
}

function convertOne(kid: ONode, state: OmmlState): string {
  switch (kid.tag) {
    case 'r':
      return runText(kid);
    case 'f': {
      const num = convertKids(oSub(kid, 'num'), state);
      const den = convertKids(oSub(kid, 'den'), state);
      return `\\frac{${num}}{${den}}`;
    }
    case 'rad': {
      // m:degHide val="1" (or an absent/empty degree) = plain sqrt.
      const radPr = oSub(kid, 'radPr');
      const degHideVal = radPr ? oat(oSub(radPr, 'degHide'), 'val') : undefined;
      const deg = convertKids(oSub(kid, 'deg'), state);
      const hide = degHideVal != null
        ? ['1', 'true', 'on'].includes(degHideVal.toLowerCase())
        : oKids(kid, 'deg').length === 0 || deg === '';
      const e = convertKids(oSub(kid, 'e'), state);
      return hide ? `\\sqrt{${e}}` : `\\sqrt[${deg}]{${e}}`;
    }
    case 'sSup':
      return `{${convertKids(oSub(kid, 'e'), state)}}^{${convertKids(oSub(kid, 'sup'), state)}}`;
    case 'sSub':
      return `{${convertKids(oSub(kid, 'e'), state)}}_{${convertKids(oSub(kid, 'sub'), state)}}`;
    case 'sSubSup':
      return `{${convertKids(oSub(kid, 'e'), state)}}_{${convertKids(oSub(kid, 'sub'), state)}}^{${convertKids(oSub(kid, 'sup'), state)}}`;
    case 'nary': {
      const naryPr = oSub(kid, 'naryPr');
      const chr = naryPr ? oat(oSub(naryPr, 'chr'), 'val') ?? '\u2211' : '\u2211';
      const op = NARY[chr] ?? '\\sum';
      const subKids = oKids(kid, 'sub');
      const supKids = oKids(kid, 'sup');
      const e = convertKids(oSub(kid, 'e'), state);
      let out = op;
      if (subKids.length) out += `_{${convertKids(subKids[0], state)}}`;
      if (supKids.length) out += `^{${convertKids(supKids[0], state)}}`;
      return `${out}{${e}}`;
    }
    case 'd': {
      const dPr = oSub(kid, 'dPr');
      const beg = dPr ? oat(oSub(dPr, 'begChr'), 'val') ?? '(' : '(';
      const end = dPr ? oat(oSub(dPr, 'endChr'), 'val') ?? ')' : ')';
      const lDelim = DELIMS[beg] ?? beg;
      const rDelim = DELIMS[end] ?? end;
      const parts = oKids(kid, 'e').map((e) => convertKids(e, state));
      return `\\left${lDelim}${parts.join(', ')}\\right${rDelim}`;
    }
    case 'acc': {
      const accPr = oSub(kid, 'accPr');
      const chr = accPr ? oat(oSub(accPr, 'chr'), 'val') ?? '\u0302' : '\u0302';
      if (!(chr in ACCENTS)) state.degraded += 1;
      const accent = ACCENTS[chr] ?? '\\hat';
      const e = convertKids(oSub(kid, 'e'), state);
      return `${accent}{${e}}`;
    }
    case 'bar': {
      const barPr = oSub(kid, 'barPr');
      const pos = barPr ? oat(oSub(barPr, 'pos'), 'val') ?? 'top' : 'top';
      const e = convertKids(oSub(kid, 'e'), state);
      return pos === 'bot' ? `\\underline{${e}}` : `\\overline{${e}}`;
    }
    case 'func': {
      const name = convertKids(oSub(kid, 'fName'), state).trim();
      const e = convertKids(oSub(kid, 'e'), state);
      // Known function names become LaTeX commands; others ride operatorname.
      if (/^[a-zA-Z]+$/.test(name)) return `\\${name}{${e}}`;
      state.degraded += 1;
      return `\\operatorname{${name}}{${e}}`;
    }
    case 'limLow': {
      const e = convertKids(oSub(kid, 'e'), state);
      const lim = convertKids(oSub(kid, 'lim'), state);
      return `${e}_{${lim}}`;
    }
    case 'limUpp': {
      const e = convertKids(oSub(kid, 'e'), state);
      const lim = convertKids(oSub(kid, 'lim'), state);
      return `${e}^{${lim}}`;
    }
    case 'm': {
      // matrix — rows are m:mr, cells m:e
      const rows = oKids(kid, 'mr').map((row) =>
        oKids(row, 'e').map((cell) => convertKids(cell, state)).join(' & '),
      );
      return `\\begin{matrix}${rows.join(' \\\\ ')}\\end{matrix}`;
    }
    case 'e':
    case 'num':
    case 'den':
    case 'sup':
    case 'sub':
    case 'deg':
    case 'lim':
    case 'fName':
    case 'mr':
    case 'oMath':
    case 'oMathPara':
      return convertKids(kid, state);
    case 'rPr':
    case 'ctrlPr':
    case 'fPr':
    case 'radPr':
    case 'sSupPr':
    case 'sSubPr':
    case 'sSubSupPr':
    case 'naryPr':
    case 'dPr':
    case 'accPr':
    case 'barPr':
    case 'funcPr':
    case 'limLowPr':
    case 'limUppPr':
    case 'mPr':
    case 'mrPr':
    case 'argPr':
    case 'argSz':
      return ''; // property containers carry no math
    default: {
      // Unknown construct: recurse into its children (the math inside
      // survives), count it — never a silent loss.
      state.degraded += 1;
      return convertKids(kid, state) || escapeMathText(kid.text);
    }
  }
}

function convertKids(node: ONode | undefined, state: OmmlState): string {
  if (!node) return '';
  let out = node.text ? escapeMathText(node.text) : '';
  for (const kid of node.kids) out += convertOne(kid, state);
  return out;
}
