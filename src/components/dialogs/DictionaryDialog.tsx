import { useMemo, useState } from 'react';
import { BookA, Plus, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSpellStore } from '@/lib/editor/spell/store';

// The personal dictionary manager. The backing file is plain text
// ({appConfigDir}/spell/dictionary-<lang>.txt, one word per line) —
// hand-editable and merge-friendly.
export function DictionaryDialog() {
  const open = useSpellStore((s) => s.dictionaryOpen);
  const closeDictionary = useSpellStore((s) => s.closeDictionary);
  const words = useSpellStore((s) => s.dictionaryWords);
  const addWord = useSpellStore((s) => s.addDictionaryWord);
  const removeWord = useSpellStore((s) => s.removeDictionaryWord);

  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');

  const visible = useMemo(
    () => words.filter((w) => w.toLowerCase().includes(filter.toLowerCase())),
    [words, filter]
  );

  function handleAdd() {
    if (addWord(draft)) setDraft('');
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : closeDictionary())}>
      <DialogContent className="max-w-sm" data-testid="dictionary-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookA size={16} /> Personal Dictionary
          </DialogTitle>
          <DialogDescription>
            Words Tensor stops flagging. Saved as plain text in your config folder.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAdd();
              }
            }}
            placeholder="Add a word…"
            className="h-8 text-sm"
            data-testid="dictionary-add-input"
          />
          <Button
            size="icon"
            variant="outline"
            className="h-8 w-8 shrink-0"
            onClick={handleAdd}
            disabled={!draft.trim()}
            aria-label="Add word"
            data-testid="dictionary-add-btn"
          >
            <Plus size={14} />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="h-7 text-xs"
          />
          <div className="mt-2 max-h-64 space-y-0.5 overflow-y-auto" data-testid="dictionary-list">
            {visible.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                {words.length === 0 ? 'Nothing added yet.' : 'No matches.'}
              </p>
            ) : (
              visible.map((w) => (
                <div
                  key={w}
                  className="group flex items-center justify-between rounded px-2 py-1 hover:bg-accent"
                >
                  <span className="truncate text-sm">{w}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5 opacity-0 group-hover:opacity-100"
                    onClick={() => removeWord(w)}
                    aria-label={`Remove ${w}`}
                    data-testid="dictionary-remove"
                  >
                    <X size={12} />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
