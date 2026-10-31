import { XMLParser } from 'fast-xml-parser';

/**
 * M-DOCX — the ORDERED XML node model (#38a). Document.xml is parsed
 * with preserveOrder into this shape because ORDER IS CONTENT in a
 * word processor: fast-xml-parser's default mode GROUPS same-named
 * children, which reordered paragraphs/tables and scrambled tab
 * sequences (the first round-trip gate run caught it). One model, one
 * helper set, shared by the import mapper and the OMML converter.
 *
 * Empty elements (no attrs/children) become kids-less ONodes with
 * empty text — presence checks are plain kid lookups, no empty-string
 * ambiguity anywhere.
 */

export interface ONode {
  tag: string;
  attrs: Record<string, string>;
  kids: ONode[];
  text: string;
}

const ORDERED_PARSER = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

function convertOrdered(entry: unknown): ONode {
  const node: ONode = { tag: '', attrs: {}, kids: [], text: '' };
  if (typeof entry === 'string') {
    node.text = entry;
    node.tag = '#text';
    return node;
  }
  if (!entry || typeof entry !== 'object') return node;
  for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
    if (key === ':@') {
      for (const attrBag of Array.isArray(value) ? value : [value]) {
        if (!attrBag || typeof attrBag !== 'object') continue;
        for (const [attrKey, attrValue] of Object.entries(attrBag as Record<string, unknown>)) {
          node.attrs[attrKey.replace(/^@_/, '')] = String(attrValue);
        }
      }
      continue;
    }
    node.tag = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
    const list = Array.isArray(value) ? value : [value];
    for (const item of list) {
      if (item && typeof item === 'object') {
        const kid = convertOrdered(item);
        if (kid.tag === '#text') node.text += kid.text;
        else node.kids.push(kid);
      } else if (typeof item === 'string') {
        node.text += item;
      }
    }
  }
  return node;
}

/** Parse one XML document into its root ONode (the <?xml ?> entry and
 *  any doctype noise are skipped). */
export function parseOrdered(xml: string): ONode {
  const parsed = ORDERED_PARSER.parse(xml);
  const roots = (Array.isArray(parsed) ? parsed : [parsed]).filter((entry) => {
    const tag = entry && typeof entry === 'object' ? Object.keys(entry as Record<string, unknown>).find((k) => k !== ':@') : null;
    return tag != null && tag !== '?xml';
  });
  return convertOrdered(roots[0] ?? {});
}

export const oKids = (node: ONode | undefined, tag: string): ONode[] =>
  node ? node.kids.filter((k) => k.tag === tag) : [];

export const oSub = (node: ONode | undefined, tag: string): ONode | undefined => oKids(node, tag)[0];

/** Attribute lookup with a namespaced fallback (r:id survives the tag
 *  prefix strip in some parser versions as 'r:id'). */
export const oat = (node: ONode | undefined, name: string): string | undefined => {
  if (!node) return undefined;
  const direct = node.attrs[name];
  if (direct != null) return direct;
  for (const [key, value] of Object.entries(node.attrs)) {
    if (key.endsWith(`:${name}`)) return value;
  }
  return undefined;
};

export const onum = (node: ONode | undefined, name: string): number | null => {
  const raw = oat(node, name);
  if (raw == null) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
};

/** An element child's w:val (sz/gridSpan/numId/ilvl are ELEMENTS). */
export const ovalNum = (node: ONode | undefined, tag: string): number | null => onum(oSub(node, tag), 'val');
export const ovalStr = (node: ONode | undefined, tag: string): string | undefined => oat(oSub(node, tag), 'val');

/** Word's on/off flags: absent = null; present without val = ON; an
 *  explicit 0/false/none/off = OFF. */
export function oflag(node: ONode | undefined): boolean | null {
  if (!node) return null;
  const v = oat(node, 'val');
  if (v == null) return true;
  return !['0', 'false', 'none', 'off'].includes(v.toLowerCase());
}
