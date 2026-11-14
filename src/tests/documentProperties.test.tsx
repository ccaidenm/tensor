import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { useDocumentStore } from '@/lib/document/store';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { useConfigStore } from '@/lib/config/store';
import { useSettingsDialogStore } from '@/lib/settings/store';
import { DocumentPropertiesDialog } from '@/components/dialogs/DocumentPropertiesDialog';
import { pasteFromSystemClipboard } from '@/lib/editor/clipboard';

/**
 * M-META — the Review > Document Properties dialog. The commit-gated
 * contract (the MarginsDialog pattern, driven the same way the
 * paginated suite drives that dialog): draft edits stay local until
 * Done, Done commits exactly once and closes, Cancel discards. The
 * keywords tag box is presentation over the one-string model — chips
 * commit on comma/Enter/blur, X and Backspace remove, a pending token
 * folds in on Done. Paste (and its focused-text-control routing) is
 * covered here too: the native menu accelerator consumes Ctrl+V, so
 * pasteFromSystemClipboard must replay into the focused field.
 */

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(async () => 'Clipboard text'),
}));

const input = (label: string) =>
  document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
const textarea = (label: string) =>
  document.querySelector(`textarea[aria-label="${label}"]`) as HTMLTextAreaElement;
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === text)!;
const chipRemove = (chip: string) =>
  document.querySelector(`button[aria-label="Remove keyword ${chip}"]`) as HTMLButtonElement;

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  fireEvent.change(el, { target: { value } });
}

function openDialog() {
  render(<DocumentPropertiesDialog />);
  act(() => {
    useDocumentPropertiesStore.getState().open();
  });
}

describe('DocumentPropertiesDialog', () => {
  beforeEach(() => {
    useDocumentStore.setState({ coreProperties: {}, isDirty: false, revision: 0, filePath: null });
    useConfigStore.setState({
      config: { ...useConfigStore.getState().config, identity: { author: '' } },
    });
    useSettingsDialogStore.setState({ isOpen: false });
    useDocumentPropertiesStore.setState({ isOpen: false });
  });

  it('draft edits stay local until Done; Done commits once and closes', () => {
    openDialog();

    typeInto(input('Title'), 'My Title');
    typeInto(input('Author'), 'Ada Lovelace');
    typeInto(input('Subject'), 'Quarterly report');
    typeInto(textarea('Comments'), 'First comments');

    // DRAFT-ONLY divergence: the store is untouched until Done.
    expect(useDocumentStore.getState().coreProperties).toEqual({});
    expect(useDocumentStore.getState().isDirty).toBe(false);

    act(() => {
      fireEvent.click(button('Done'));
    });

    expect(useDocumentStore.getState().coreProperties).toEqual({
      title: 'My Title',
      author: 'Ada Lovelace',
      subject: 'Quarterly report',
      comments: 'First comments',
    });
    expect(useDocumentStore.getState().isDirty).toBe(true);
    expect(useDocumentPropertiesStore.getState().isOpen).toBe(false);
  });

  it('whitespace-only values drop out of the commit (the store normalizes)', () => {
    openDialog();
    typeInto(input('Title'), '   ');
    typeInto(input('Author'), '  Ada  ');
    act(() => {
      fireEvent.click(button('Done'));
    });
    expect(useDocumentStore.getState().coreProperties).toEqual({ author: 'Ada' });
  });

  it('Cancel discards the draft', () => {
    useDocumentStore.getState().setCoreProperties({ title: 'Original' });
    useDocumentStore.setState({ isDirty: false });
    openDialog();
    typeInto(input('Title'), 'Changed');
    act(() => {
      fireEvent.click(button('Cancel'));
    });
    expect(useDocumentPropertiesStore.getState().isOpen).toBe(false);
    expect(useDocumentStore.getState().coreProperties).toEqual({ title: 'Original' });
  });

  it('the draft re-syncs from the store on reopen', () => {
    openDialog();
    act(() => {
      useDocumentStore.getState().setCoreProperties({ title: 'From Store' });
      useDocumentPropertiesStore.getState().open();
    });
    expect(input('Title').value).toBe('From Store');
  });

  it("a pristine document's author is seeded from the config identity (editable, not locked)", () => {
    useConfigStore.setState({
      config: { ...useConfigStore.getState().config, identity: { author: 'Config Author' } },
    });
    openDialog();
    // The pristine-doc subscribe (store.ts) already seeded the author —
    // the identity shows as the VALUE, editable like any other field.
    expect(input('Author').value).toBe('Config Author');

    typeInto(input('Author'), 'Someone Else');
    act(() => {
      fireEvent.click(button('Done'));
    });
    expect(useDocumentStore.getState().coreProperties.author).toBe('Someone Else');
  });

  it('a non-pristine doc without an author shows the identity as a placeholder suggestion', () => {
    useConfigStore.setState({
      config: { ...useConfigStore.getState().config, identity: { author: 'Config Author' } },
    });
    // filePath set → non-pristine: the subscribe no longer seeds, the
    // document owns its (empty) properties.
    useDocumentStore.setState({ filePath: '/x/doc.wpdoc', isDirty: false, coreProperties: {} });
    openDialog();
    expect(input('Author').value).toBe('');
    expect(input('Author').placeholder).toBe('Config Author');
  });
});

describe('DocumentPropertiesDialog keywords field background (the user\'s ask)', () => {
  it('matches the Input fields: transparent + dark input tint, NEVER bg-muted', () => {
    openDialog();
    const pending = document.querySelector('input[aria-label="Keywords"]') as HTMLInputElement;
    expect(pending).toBeTruthy();
    const box = pending.parentElement!;
    expect(box.className).toContain('bg-transparent');
    expect(box.className).toContain('dark:bg-input/30');
    expect(box.className).not.toContain('bg-muted');
  });
});

describe('formatMarginsSummary (the print dialog\'s human Paper card)', () => {
  it('uniform → "all sides"; paired → top/bottom · left/right; mixed → per side', async () => {
    const { formatMarginsSummary } = await import('@/lib/document/pageSetup');
    const u = { top: 72, bottom: 72, left: 72, right: 72 };
    expect(formatMarginsSummary(u, 'inches')).toBe('1" all sides');
    const p = { top: 72, bottom: 72, left: 90, right: 90 };
    expect(formatMarginsSummary(p, 'inches')).toBe('1" top/bottom · 1.25" left/right');
    const m = { top: 72, bottom: 36, left: 90, right: 54 };
    expect(formatMarginsSummary(m, 'inches')).toBe('T 1" · B 0.5" · L 1.25" · R 0.75"');
    // cm speaks its suffix (never the inch mark)
    expect(formatMarginsSummary(u, 'centimeters')).toBe('2.54 cm all sides');
  });
});

describe('DocumentPropertiesDialog keywords tag box', () => {
  beforeEach(() => {
    useDocumentStore.setState({ coreProperties: {}, isDirty: false, revision: 0, filePath: null });
    useDocumentPropertiesStore.setState({ isOpen: false });
  });

  it('comma commits a chip; chips carry an X; Done joins the string', () => {
    openDialog();
    const keywords = input('Keywords');

    typeInto(keywords, 'tensor');
    fireEvent.keyDown(keywords, { key: ',' });
    expect(chipRemove('tensor')).toBeTruthy();
    expect(keywords.value).toBe(''); // input cleared, chip rendered
    // DRAFT-ONLY: the store is untouched until Done.
    expect(useDocumentStore.getState().coreProperties).toEqual({});

    typeInto(keywords, 'privacy');
    fireEvent.keyDown(keywords, { key: ',' });
    expect(chipRemove('privacy')).toBeTruthy();

    act(() => {
      fireEvent.click(button('Done'));
    });
    expect(useDocumentStore.getState().coreProperties.keywords).toBe('tensor, privacy');
  });

  it('blur commits the pending token (click-out-of-focus adds the chip)', () => {
    openDialog();
    const keywords = input('Keywords');
    typeInto(keywords, 'editor');
    fireEvent.blur(keywords);
    expect(chipRemove('editor')).toBeTruthy();
    act(() => {
      fireEvent.click(button('Done'));
    });
    expect(useDocumentStore.getState().coreProperties.keywords).toBe('editor');
  });

  it('the X button removes a chip', () => {
    openDialog();
    const keywords = input('Keywords');
    typeInto(keywords, 'tensor');
    fireEvent.keyDown(keywords, { key: ',' });
    typeInto(keywords, 'privacy');
    fireEvent.keyDown(keywords, { key: ',' });

    act(() => {
      fireEvent.click(chipRemove('tensor'));
    });
    expect(chipRemove('tensor')).toBeNull();
    expect(chipRemove('privacy')).toBeTruthy();

    act(() => {
      fireEvent.click(button('Done'));
    });
    expect(useDocumentStore.getState().coreProperties.keywords).toBe('privacy');
  });

  it('Backspace on an empty input pops the last chip', () => {
    openDialog();
    const keywords = input('Keywords');
    typeInto(keywords, 'tensor');
    fireEvent.keyDown(keywords, { key: ',' });
    typeInto(keywords, 'privacy');
    fireEvent.keyDown(keywords, { key: ',' });
    expect(chipRemove('tensor')).toBeTruthy();
    expect(chipRemove('privacy')).toBeTruthy();

    fireEvent.keyDown(keywords, { key: 'Backspace' });
    expect(chipRemove('privacy')).toBeNull();
    expect(chipRemove('tensor')).toBeTruthy();
  });

  it('a pending uncommitted token still lands on Done (no reliance on blur)', () => {
    openDialog();
    typeInto(input('Keywords'), 'privacy');
    act(() => {
      fireEvent.click(button('Done'));
    });
    expect(useDocumentStore.getState().coreProperties.keywords).toBe('privacy');
  });
});

describe('focused-text-control paste (the native-accelerator fix)', () => {
  beforeEach(() => {
    useDocumentStore.setState({ coreProperties: {}, isDirty: false, revision: 0, filePath: null });
    useDocumentPropertiesStore.setState({ isOpen: false });
  });

  it('paste goes into the focused dialog field, never the editor', async () => {
    openDialog();
    const title = input('Title');
    title.focus();
    expect(document.activeElement).toBe(title);

    // A stub editor — the focused-control path must never touch it.
    const editorStub = { view: { dom: document.createElement('div') } };
    await act(async () => {
      await pasteFromSystemClipboard(editorStub as never);
    });

    expect(title.value).toBe('Clipboard text');

    // The React onChange wiring commits the draft — Done lands it.
    act(() => {
      fireEvent.click(button('Done'));
    });
    expect(useDocumentStore.getState().coreProperties.title).toBe('Clipboard text');
  });
});
