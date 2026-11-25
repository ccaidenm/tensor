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

/** The menu item's right-aligned shortcut: the user's live binding for
 *  the id, Word's convention. Nothing renders when the command is unbound. */
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
 * #100/#103 — the h-10 titlebar row that IS the window chrome, shared
 * by the editor and the start screen (which owns it without the ribbon).
 * variant 'home': simplified menu, drag-only name lane, own card frame.
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
            #100 — the native macOS traffic lights overlay this edge
            (titleBarStyle: Overlay); reserve an empty drag lane so
            the Tensor button clears them.
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
                  {/* Markdown and Word exports; PDF joins when #39 lands. */}
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
              {/* #103 — "Library" names the start screen (templates, recents, open). */}
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
          #100 — the drag lane absorbs the leftover width; double-click
          toggles maximize (Tauri's drag listener owns the mousedown).
          The doc name sits window-centered on Linux/Windows, far right on macOS.
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
