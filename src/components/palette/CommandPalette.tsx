import { useMemo, useState } from 'react';
import { Table } from 'lucide-react';
import { usePaletteStore } from '@/lib/palette/store';
import { useAppCommands } from '@/lib/commands/useAppCommands';
import type { CommandAction, CommandGroup as CommandGroupKind } from '@/lib/commands/registry';
import { useShortcutDisplay } from '@/lib/useShortcutDisplay';
import { insertTableAtSelection, parseTableDims } from '@/lib/editor/tableInsert';
import { useDocumentStore } from '@/lib/document/store';
import { formatShortcutParts } from '@/lib/shortcuts';
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

/**
 * M-PALETTE. Pure chrome over the command registry — never an editor
 * surface: it reads nothing from ProseMirror and writes nothing to it,
 * so opening it can't move the selection or scroll the document. The
 * PM selection stays intact for the whole overlay lifetime; closing
 * (palette store) refocuses the editor and the caret comes back where
 * it was.
 */

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

  // M-T3b — the typed table spec: "4x4" (also "4 x 4", "4×4",
  // "table 4x4", "4x4 table") parses to a table-create command with
  // dimensions BEYOND the grid picker's 8×8 hover grid. The item's
  // value embeds the "create N×M table" text so cmdk's own filter
  // matches the search; dims=null renders nothing.
  const [search, setSearch] = useState('');
  const tableDims = useMemo(() => parseTableDims(search), [search]);
  const tableEditor = useDocumentStore((s) => s.editor);

  // Close FIRST, then run: close() refocuses the editor while the
  // selection is still intact (editor commands apply to it), and any
  // dialog the command opens (settings, properties...) takes focus
  // after — never fighting the palette for it.
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
        ↑↓ navigate · ↵ run · esc close
      </div>
    </CommandDialog>
  );
}
