import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, CornerDownLeft, Omega, Table } from 'lucide-react';
import { usePaletteStore } from '@/lib/palette/store';
import { useAppCommands } from '@/lib/commands/useAppCommands';
import type { CommandAction, CommandGroup as CommandGroupKind } from '@/lib/commands/registry';
import { useShortcutDisplay } from '@/lib/useShortcutDisplay';
import { insertTableAtSelection, parseTableDims } from '@/lib/editor/tableInsert';
import { useDocumentStore } from '@/lib/document/store';
import { formatShortcutParts } from '@/lib/shortcuts';
import { parseCodepointQuery } from '@/lib/editor/symbols/catalog';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';

// Pure chrome over the command registry — reads nothing from
// ProseMirror and writes nothing to it, so the selection survives the
// whole overlay lifetime; closing refocuses the editor.

const GROUP_ORDER: { group: CommandGroupKind; heading: string }[] = [
  { group: 'actions', heading: 'Actions' },
  { group: 'format', heading: 'Format' },
  { group: 'navigate', heading: 'Navigate' },
];

/** The user's LIVE binding for a command's shortcut — pulled from
 *  config via getEffectiveKeybinding, so a rebind made in Settings is
 *  what the hint shows (and updates live). */
function ShortcutHint({ shortcutId }: { shortcutId: string }) {
  const binding = useShortcutDisplay(shortcutId);
  if (!binding) return null;
  return (
    <CommandShortcut data-testid={`palette-hint-${shortcutId}`}>
      <KbdGroup>
        {formatShortcutParts(binding).map((part) => (
          <Kbd key={part}>{part}</Kbd>
        ))}
      </KbdGroup>
    </CommandShortcut>
  );
}

function PaletteItem({ command, onRun }: { command: CommandAction; onRun: (c: CommandAction) => void }) {
  const Icon = command.icon;
  return (
    <CommandItem
      data-testid={`palette-item-${command.id}`}
      value={`${command.title} ${command.keywords.join(' ')}`}
      onSelect={() => onRun(command)}
    >
      {Icon ? <Icon /> : null}
      <span>{command.title}</span>
      {command.shortcutId ? <ShortcutHint shortcutId={command.shortcutId} /> : null}
    </CommandItem>
  );
}

export function CommandPalette() {
  const isOpen = usePaletteStore((s) => s.isOpen);
  const editorContext = usePaletteStore((s) => s.editorContext);
  const commands = useAppCommands(editorContext);

  // The typed table spec ("4x4", "table 4x4", …) parses to a create-table
  // command with dims beyond the grid picker's 8×8. The item's value
  // embeds the text so cmdk's own filter matches the search.
  const [search, setSearch] = useState('');
  const tableDims = useMemo(() => parseTableDims(search), [search]);
  const tableEditor = useDocumentStore((s) => s.editor);
  // "U+03A9" in the search surfaces a one-item insert group —
  // keyboard-first symbol entry.
  const codepoint = useMemo(() => parseCodepointQuery(search), [search]);

  // Close first, then run: close() refocuses the editor while the
  // selection is intact, and any dialog the command opens takes
  // focus after — never fighting the palette for it.
  const runCommand = (command: CommandAction) => {
    usePaletteStore.getState().close();
    void command.run();
  };

  return (
    <CommandDialog
      title="Command Palette"
      description="Search for a command to run..."
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) usePaletteStore.getState().close();
      }}
      className="sm:max-w-lg"
    >
      <Command>
        <CommandInput
          data-testid="palette-input"
          placeholder="Type a command or search…"
          onValueChange={setSearch}
        />
        <CommandList>
          <CommandEmpty>No matching commands.</CommandEmpty>
          {codepoint !== null && tableEditor && editorContext ? (
            <CommandGroup heading="Insert character">
              <CommandItem
                value={`insert character u+${search.trim().replace(/^u\+\s*/i, '').toLowerCase()} u+${codepoint.toString(16).padStart(4, '0')} unicode symbol`}
                data-testid="palette-codepoint-insert"
                onSelect={() => {
                  const editor = useDocumentStore.getState().editor;
                  if (!editor) return;
                  usePaletteStore.getState().close();
                  editor.chain().focus().insertContent(String.fromCodePoint(codepoint)).run();
                }}
              >
                <Omega size={16} className="text-muted-foreground" />
                Insert U+{codepoint.toString(16).toUpperCase()} “{String.fromCodePoint(codepoint)}”
                <span className="text-muted-foreground">
                  — type U+ followed by up to 6 hex digits
                </span>
              </CommandItem>
            </CommandGroup>
          ) : null}
          {tableDims && tableEditor && editorContext ? (
            <CommandGroup heading="Create table">
              <CommandItem
                value={`create ${tableDims.rows}x${tableDims.cols} table insert`}
                data-testid="palette-table-dims"
                onSelect={() => {
                  const editor = useDocumentStore.getState().editor;
                  if (!editor) return;
                  usePaletteStore.getState().close();
                  insertTableAtSelection(editor, {
                    rows: tableDims.rows,
                    cols: tableDims.cols,
                    withHeaderRow: true,
                  });
                }}
              >
                <Table size={16} className="text-muted-foreground" />
                Create {tableDims.rows}×{tableDims.cols} table
                <span className="text-muted-foreground">
                  — type N×M beyond the 8×8 grid
                </span>
              </CommandItem>
            </CommandGroup>
          ) : null}
          {GROUP_ORDER.map(({ group, heading }) => {
            const items = commands.filter((c) => c.group === group);
            if (items.length === 0) return null;
            return (
              <CommandGroup key={group} heading={heading}>
                {items.map((command) => (
                  <PaletteItem key={command.id} command={command} onRun={runCommand} />
                ))}
              </CommandGroup>
            );
          })}
        </CommandList>
      </Command>
      <div
        data-testid="palette-footer"
        className="border-t px-3 py-2 text-center text-xs text-muted-foreground"
      >
        <div className="flex items-center justify-between px-2 py-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <Kbd>
              <CornerDownLeft className="size-3.5" />
            </Kbd>
            <span>to select</span>
          </div>
          <div className="flex items-center gap-1">
            <Kbd>
              <ArrowUp className="size-3.5" />
            </Kbd>
            <Kbd>
              <ArrowDown className="size-3.5" />
            </Kbd>
            <span>to navigate</span>
            <span>·</span>
            <Kbd>esc</Kbd>
            <span>to close</span>
          </div>
        </div>
      </div>
    </CommandDialog>
  );
}
