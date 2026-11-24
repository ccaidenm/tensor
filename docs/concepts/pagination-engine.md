# The pagination engine

`packages/engine` is a standalone, dependency-free layout package. It takes a semantic description of a document and returns positioned geometry: which line of text sits on which page, at which coordinates, with its baseline where. This page is the *why*; the package's own [`ARCHITECTURE.md`](../../packages/engine/ARCHITECTURE.md) is the detailed spec.

## Why a separate package

Three reasons, one enforced:

1. **Purity is a test.** The engine's `src/` is scanned for DOM, canvas, and window references, and the suite fails on any hit. A layout engine that cannot touch a ruler must be *given* one, which makes every rule testable against a fake ruler with exact numbers.
2. **Layout becomes a pure function of its inputs.** Same document, same options, same output -- byte for byte. That determinism is what makes the incremental cache safe to trust.
3. **The boundary is the design.** The engine computes and never paints; the shell paints and never computes. Between them flows pure data, so neither side can drift into the other's job.

## The shape of the data

In: a `SemanticDoc` -- paragraph, heading, and code blocks with runs and styles, plus header/footer bands as a sibling input. Out: a `LayoutResult` -- pages, line boxes (with baselines and run boundaries), and fragment breaks. Everything a renderer or the editor needs is a *positioned fact* in the output; consumers never derive geometry.

## The placement machine

Text is broken greedily (spaces only, no hyphenation) and placed block by block under a small set of rules with Word-shaped names: orphan control moves a block whose first line strands; widow control backs a break up one line; `keepNext`/`keepPrevious` bonds make a block's last line share a page with its successor's first; forced page and column breaks close at their boundaries. Precedence is fixed: forced breaks outrank orphans, orphans outrank bonds, bonds outrank widow fixes -- and the machine guarantees termination even when a page is too small to honor any minimum.

One idea carries most of the weight: the **Markov property**. A block's placement depends only on its entry state, its own content, and the page options -- nothing hidden flows between blocks. That is what makes the cache's reuse provable instead of hopeful.

## The incremental cache

A warm engine reuses everything the document didn't touch: unchanged prefixes are resumed, unchanged suffixes are spliced, and bonded blocks extend both directions. The guarantee is the **parity law** -- warm output must deep-equal cold output -- enforced forever by a randomized fuzzer (40 fixed seeds, real cache bugs caught and pinned). After a hash-only edit to block 250 of 300, the engine walks one block and splices the rest.

Columns ride the same machine as a flow dimension, and column balancing is an output transform, never a cache write.

## What it deliberately does not do

The engine never paints, never loads fonts, never persists, and never reads the DOM. Measurement arrives through one injected `TextMetrics` port (the shell's single ruler), styling is the adapter's job, and every unimplemented API surface throws loudly rather than guessing.

## See also

- [`packages/engine/ARCHITECTURE.md`](../../packages/engine/ARCHITECTURE.md) -- the full spec, every rule pinned by a named test
- [Architecture](architecture.md) -- the three-layer model this package sits in
- [The file format](file-format.md) -- what the engine's input is saved as
