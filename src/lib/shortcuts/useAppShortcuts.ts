import { useEffect } from 'react';
import { useConfigStore } from '@/lib/config/store';
import { usePrintPreviewStore } from '@/components/dialogs/PrintPreviewDialog';
import { usePaletteStore } from '@/lib/palette/store';
import { useSettingsDialogStore } from '@/lib/settings/store';
import { getCommand } from '@/lib/commands/registry';
import { getEffectiveKeybinding, matchesShortcut, SHORTCUTS } from '@/lib/shortcuts';

/**
 * App-context shortcuts dispatch through the command registry — the
 * same run() bodies the menu and palette use. Every app-context
 * SHORTCUTS id resolves to a registry command ('palette' included).
 */
export function useAppShortcuts() {
  const keybindings = useConfigStore((s) => s.config.keybindings);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Settings open ⇒ all app shortcuts suppressed (Ctrl+S would
      // silently save in the background). Pairs with ShortcutsExtension's
      // guard — new conditions go in BOTH or the keymap forks by focus.
      if (useSettingsDialogStore.getState().isOpen) return;
      if (usePaletteStore.getState().isOpen) return;
      if (usePrintPreviewStore.getState().isOpen) return;

      for (const def of SHORTCUTS) {
        if (def.context !== 'app') continue;
        const binding = getEffectiveKeybinding(keybindings, def.id);
        if (!binding || !matchesShortcut(e, binding)) continue;

        const command = getCommand(def.id);
        if (command) {
          void command.run();
          e.preventDefault();
          return;
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [keybindings]);
}
