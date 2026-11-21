import { useEffect, type ReactNode } from 'react';
import { useShortcutDisplay } from '@/lib/useShortcutDisplay';
import { formatShortcutParts } from '@/lib/shortcuts';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TensorLogo } from '@/components/icons/TensorIcon';

/** The menu item's right-aligned shortcut: the USER'S live binding for
 *  the id (useShortcutDisplay), Word's convention. Nothing renders when
 *  the command is unbound (Save As…, Export — the no-binding lie). */
function MenuShortcut({ id }: { id: string }) {
  const binding = useShortcutDisplay(id);
  if (!binding) return null;
  return (
    <span className="ml-auto pl-6 text-xs tracking-wider text-muted-foreground">
      {formatShortcutParts(binding).join('+')}
    </span>
  );
}
import { WindowControls } from '@/components/layout/WindowControls';
import { useDocumentStore } from '@/lib/document/store';
import { useSettingsDialogStore } from '@/lib/settings/store';
import { useConfigStore } from '@/lib/config/store';
import { getCommand } from '@/lib/commands/registry';
import { inTauriWindow, isMacOS } from '@/lib/window/tauriEnv';
import { cn } from 'cn';

/**
 * #100/#103 — THE MERGED TITLEBAR ROW: the h-10 strip that IS the
 * window chrome (the Tensor menu, the tab lane, the drag regions, the
 * document name, the window controls). Extracted from the Ribbon so
 * the START SCREEN can own the same chrome without the ribbon: the
 * app renders this row in both modes, with the ribbon tabs riding as
 * the editor variant's children (inside the Ribbon's Tabs context).
 *
 * variant 'home': the Tensor menu simplifies to Open…/Settings/Quit
 * (New lives on the start screen itself; Save/Export own nothing
 * without a document), the name lane is drag-only, and the row
 * carries its own card frame + border (the editor variant borrows the
 * Tabs strip's).
 */

interface TitleBarRowProps {
  variant: 'editor' | 'home';
  /** The editor variant's tab lane (rendered inside the Tabs context
   *  by the Ribbon; the home variant has none). */
  children?: ReactNode;
}

export function TitleBarRow({ variant, children }: TitleBarRowProps) {
  const filePath = useDocumentStore((s) => s.filePath);
  const isDirty = useDocumentStore((s) => s.isDirty);
  const openFile = useDocumentStore((s) => s.openFile);
  const controlsSide = useConfigStore((s) => s.config.windowControlsSide);

  const isHome = variant === 'home';
  const displayName = filePath ? filePath.split('/').pop() : 'Untitled';

  // The OS window title follows the surface (taskbar, alt-tab): the
  // document in the editor, plain "Tensor" on the start screen.
  useEffect(() => {
    if (!inTauriWindow()) return;
    const title = isHome
      ? 'Tensor'
      : `${displayName}${isDirty ? ' •' : ''} — Tensor`;
    void getCurrentWindow().setTitle(title);
  }, [displayName, isDirty, isHome]);

  return (
    <div
      className={cn(
        'relative h-10',
        isHome && 'border-b border-border bg-card',
      )}
    >
      <div className="relative z-10 flex h-10 items-center px-1">
        <div className="flex h-10 items-center">
          {/*
            #100 — the macOS lane: the native traffic lights overlay
            the row's left edge (titleBarStyle: Overlay in
            tauri.conf); reserve their lane (a drag region — it is
            empty chrome) so the Tensor button clears them. Linux/
            Windows never reserves it: the row IS the frame.
          */}
          {!isMacOS() && controlsSide === 'left' && <WindowControls />}
          {isMacOS() && (
            <div className="h-full w-[68px] flex-none" data-tauri-drag-region />
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-10 flex-none rounded-none px-3 text-primary text-sm hover:text-primary"
                >
                  <TensorLogo size={16} />
                  Tensor
                </Button>
              }
            />
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => void openFile()}>
                Open…
                <MenuShortcut id='open' />
              </DropdownMenuItem>
              {variant === 'editor' && (
                <>
                  <DropdownMenuItem onClick={() => void useDocumentStore.getState().save()}>
                    Save
                    <MenuShortcut id='save' />
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void useDocumentStore.getState().saveAs()}>
                    Save As…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* M-MD/M-DOCX: the export surface — Markdown and Word
                      now; PDF joins when #39 lands. */}
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Export</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={() => void useDocumentStore.getState().exportMarkdown()}>
                        Markdown (.md)…
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void useDocumentStore.getState().exportDocx()}>
                        Word Document (.docx)…
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              )}
              <DropdownMenuSeparator />
              {/* #103 — the LIBRARY item (the user's naming): the start
                  screen IS the library — templates, recents, open. The
                  return path from a live doc is the start screen's OWN
                  return card (the menu item was its clumsy twin). */}
              <DropdownMenuItem onClick={() => useDocumentStore.getState().goHome()}>
                Library
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => useSettingsDialogStore.getState().open()}>
                Settings
                <MenuShortcut id='openSettings' />
              </DropdownMenuItem>
              {variant === 'home' && (
                <DropdownMenuItem onClick={() => void getCommand('quit')?.run()}>
                  Quit Tensor
                  <MenuShortcut id='quit' />
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {children}
        </div>

        {/*
          #100 — THE TITLE LANES. The drag lane absorbs the row's
          leftover width (data-tauri-drag-region; double-click toggles
          maximize — the tauri drag listener owns the mousedown). The
          document name: on Linux/Windows it floats ABSOLUTELY
          CENTERED in the WINDOW (the user's ruling), dragging on its
          own band; on macOS it stays in-flow at the far right (the
          traffic lights own the left lane). The HOME variant has no
          name — the whole lane drags.
        */}
        <div className="min-w-3 flex-1 self-stretch" data-tauri-drag-region />
        {!isHome &&
          (isMacOS() ? (
            <span
              className="max-w-[240px] truncate px-2 text-sm text-muted-foreground"
              data-tauri-drag-region
            >
              {displayName}
              {isDirty ? ' •' : ''}
            </span>
          ) : (
            <span
              className="absolute left-1/2 top-0 z-20 flex h-10 max-w-[240px] -translate-x-1/2 items-center truncate px-2 text-sm text-muted-foreground"
              data-tauri-drag-region
            >
              {displayName}
              {isDirty ? ' •' : ''}
            </span>
          ))}
        {!isMacOS() && controlsSide === 'right' && <WindowControls />}
      </div>

      {!isHome && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-0.5 bg-border" />
      )}
    </div>
  );
}
