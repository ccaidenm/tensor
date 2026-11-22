import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { useDocumentStore } from '@/lib/document/store';
import { useConfigStore } from '@/lib/config/store';
import type { DocumentCoreProperties } from '@/lib/document/coreProperties';

// The core-properties editor. Fields edit a draft; Done makes exactly one
// setCoreProperties call (one autosave cycle); Cancel discards. Keywords
// stay one comma-separated string in the model — the tag box is presentation.

interface PropertyFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

function PropertyInput({ label, value, placeholder, onChange }: PropertyFieldProps) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-20 flex-none text-muted-foreground">{label}</span>
      <Input
        className="h-8"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function PropertyTextarea({ label, value, onChange }: Omit<PropertyFieldProps, 'placeholder'>) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <span className="mt-1.5 w-20 flex-none text-muted-foreground">{label}</span>
      <Textarea
        className="min-h-16"
        rows={3}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Pure: the draft's keywords string folded with the pending token —
 *  "tensor, priva" + "vacy" → "tensor, priva, vacy". Commit handlers
 *  and Done both compute through this, so blur timing cannot diverge. */
function keywordsWithPending(draftKeywords: string, pending: string): string {
  const chips = draftKeywords.split(',').map((t) => t.trim()).filter(Boolean);
  const token = pending.trim();
  return token ? [...chips, token].join(', ') : chips.join(', ');
}

interface KeywordsFieldProps {
  chips: string[];
  pending: string;
  onPendingChange: (value: string) => void;
  onCommit: () => void;
  onRemove: (index: number) => void;
}

/** The keywords tag box: chips + a trailing free-text input, purely
 *  presentational — mutations route back to the draft string. */
function KeywordsField({ chips, pending, onPendingChange, onCommit, onRemove }: KeywordsFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="mt-1.5 w-20 flex-none text-muted-foreground">Keywords</span>
      <div
        className="flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-2 py-1 transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50 dark:bg-input/30"
        onClick={(e) => { if (e.target === e.currentTarget) inputRef.current?.focus(); }}
      >
        {chips.map((chip, i) => (
          <span
            key={`${chip}-${i}`}
            className="flex items-center gap-0.5 rounded border border-border bg-muted px-1.5 py-0.5 text-xs"
          >
            {chip}
            <button
              type="button"
              aria-label={`Remove keyword ${chip}`}
              className="text-muted-foreground cursor-pointer hover:text-foreground"
              onClick={() => onRemove(i)}
            >
              <X size={10} strokeWidth={2.5} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="min-w-16 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          aria-label="Keywords"
          placeholder={chips.length ? 'Add keyword…' : ''}
          value={pending}
          onChange={(e) => onPendingChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === ',' || e.key === 'Enter') {
              e.preventDefault();
              onCommit();
            } else if (e.key === 'Backspace' && pending === '' && chips.length > 0) {
              onRemove(chips.length - 1);
            }
          }}
          onBlur={onCommit}
        />
      </div>
    </div>
  );
}

export function DocumentPropertiesDialog() {
  const isOpen = useDocumentPropertiesStore((s) => s.isOpen);
  const close = useDocumentPropertiesStore((s) => s.close);
  const coreProperties = useDocumentStore((s) => s.coreProperties);
  const setCoreProperties = useDocumentStore((s) => s.setCoreProperties);
  const identityAuthor = useConfigStore((s) => s.config.identity.author);

  const [draft, setDraft] = useState<DocumentCoreProperties>(() => coreProperties);
  const [pendingKeywords, setPendingKeywords] = useState('');

  // Re-sync the draft from the store each time the dialog opens (or
  // the store's properties change underneath it — e.g. a loaded file).
  // A half-typed keyword never survives a reopen.
  useEffect(() => {
    if (isOpen) {
      setDraft(coreProperties);
      setPendingKeywords('');
    }
  }, [isOpen, coreProperties]);

  /** Draft only — no store write until Done. */
  function edit(key: keyof DocumentCoreProperties, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  /** Comma/Enter/blur: fold the pending token into the draft. The blur
   *  handler may run first on a Done click — harmless, same pure function. */
  function commitKeywordsPending() {
    edit('keywords', keywordsWithPending(draft.keywords ?? '', pendingKeywords));
    setPendingKeywords('');
  }

  function removeKeyword(index: number) {
    const chips = (draft.keywords ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    edit('keywords', chips.filter((_, i) => i !== index).join(', '));
  }

  /** One commit → one dirty flag, then close. Normalization (trim,
   *  empty-drop) is the store's job, not the dialog's. */
  function done() {
    setCoreProperties({
      ...draft,
      keywords: keywordsWithPending(draft.keywords ?? '', pendingKeywords),
    });
    close();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Document Properties</DialogTitle>
          <DialogDescription>
            Metadata for this document.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <PropertyInput label="Title" value={draft.title ?? ''} onChange={(v) => edit('title', v)} />
          <PropertyInput
            label="Author"
            value={draft.author ?? ''}
            placeholder={identityAuthor || undefined}
            onChange={(v) => edit('author', v)}
          />
          <PropertyInput label="Subject" value={draft.subject ?? ''} onChange={(v) => edit('subject', v)} />
          <KeywordsField
            chips={(draft.keywords ?? '').split(',').map((t) => t.trim()).filter(Boolean)}
            pending={pendingKeywords}
            onPendingChange={setPendingKeywords}
            onCommit={commitKeywordsPending}
            onRemove={removeKeyword}
          />
          <PropertyTextarea label="Comments" value={draft.comments ?? ''} onChange={(v) => edit('comments', v)} />
        </div>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
          <Button size="sm" onClick={done}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
