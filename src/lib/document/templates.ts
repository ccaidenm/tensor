/**
 * #103 — THE TEMPLATE CATALOG: the start screen's document sources.
 * TWO ROWS (the user's structure): the CORE pair — the explicit
 * view-mode blanks (Tensor's two identities; the Open card joins them
 * as the row's third, UI-side) — then the STARTERS (hand-authored
 * HTML the editor's setContent consumes; four genres, deliberately
 * simple, deliberately few).
 *
 * DATA-ONLY (no imports of React/lucide — the icons/colors live in
 * the StartScreen's visual map, keyed by id): this file is the
 * document source, the component is the presentation.
 */

export interface DocTemplate {
  id: string;
  title: string;
  description: string;
  kind: 'blank' | 'starter';
  /** The blanks pick their surface explicitly (the config default
   *  never decides — the two cards ARE the choice). */
  viewMode: 'pages' | 'pageless';
  /** Starter content (editor HTML). Blanks carry none. */
  content?: string;
}

const TODAY = '<p>[Date]</p>';

export const BLANKS: readonly DocTemplate[] = [
  {
    id: 'blank-paginated',
    title: 'Blank document',
    description: 'Paginated — print-ready pages',
    kind: 'blank',
    viewMode: 'pages',
  },
  {
    id: 'blank-pageless',
    title: 'Blank document',
    description: 'Pageless — one continuous flow',
    kind: 'blank',
    viewMode: 'pageless',
  },
] as const;

export const STARTERS: readonly DocTemplate[] = [
  {
    id: 'letter',
    title: 'Letter',
    description: 'A classic correspondence layout',
    kind: 'starter',
    viewMode: 'pages',
    content: `${TODAY}<p>Dear [Recipient],</p><p>[Opening — why you're writing.]</p><p>[Body — the details that matter.]</p><p>[Close — what happens next.]</p><p>Sincerely,</p><p>[Your name]</p>`,
  },
  {
    id: 'report',
    title: 'Simple report',
    description: 'Summary, details, and conclusion',
    kind: 'starter',
    viewMode: 'pages',
    content:
      '<h1>[Report title]</h1>' +
      '<p>[One-paragraph summary of the whole report.]</p>' +
      '<h2>Details</h2><p>[What was done, how, and what was found.]</p>' +
      '<h2>Conclusion</h2><p>[What it means and what should happen next.]</p>',
  },
  {
    id: 'meeting-notes',
    title: 'Meeting notes',
    description: 'Agenda, notes, and action items',
    kind: 'starter',
    viewMode: 'pages',
    content:
      '<h1>[Meeting title]</h1>' +
      '<p>[Date] · [Attendees]</p>' +
      '<h2>Agenda</h2><ul><li>[Topic one]</li><li>[Topic two]</li></ul>' +
      '<h2>Notes</h2><p>[What was discussed.]</p>' +
      '<h2>Action items</h2><ul><li>[ ] [Owner] — [What, by when]</li></ul>',
  },
  {
    id: 'proposal',
    title: 'Project proposal',
    description: 'Problem, solution, and timeline',
    kind: 'starter',
    viewMode: 'pages',
    content:
      '<h1>[Project title]</h1>' +
      '<h2>The problem</h2><p>[What is broken, and why it matters now.]</p>' +
      '<h2>The proposed solution</h2><p>[What you propose, and how it works.]</p>' +
      '<h2>Timeline</h2><p>[Phases and dates.]</p>' +
      '<h2>What we need</h2><p>[Budget, people, decisions.]</p>',
  },
] as const;
