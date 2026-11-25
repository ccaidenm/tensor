import { useState, type ReactNode } from 'react';
import { Monitor, Moon, PanelLeftClose, PanelRightClose, Sun, Type, Paintbrush, User, Mouse, Terminal, FolderOpen } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useConfigStore } from '@/lib/config/store';
import { isMacOS } from '@/lib/window/tauriEnv';
import { ACCENTS, type AccentId } from '@/lib/branding/accents';
import { useSettingsDialogStore } from '@/lib/settings/store';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  STACKED_DIALOG_CONTENT,
  STACKED_DIALOG_OVERLAY,
} from '@/components/ui/dialog';
import { ColorPickerButton } from '@/components/layout/ribbon/ColorPickerButton';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { cn } from 'cn';
import type { SettingsSectionDefinition } from '@/lib/settings/types';

export const GENERAL_PANEL_SECTIONS: SettingsSectionDefinition[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'user', label: 'User' },
  { id: 'editor', label: 'Editor' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'advanced', label: 'Advanced' },
];

function Row({ icon, label, description, children }: { icon: ReactNode; label: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-muted-foreground">{icon}</div>
        <div>
          <div className="text-sm font-medium">{label}</div>
          {description && <div className="text-xs text-muted-foreground">{description}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

/** The identity row's "Review > Document Properties" reference is live —
 *  it closes Settings and opens the dialog. */
function openDocumentProperties() {
  useSettingsDialogStore.getState().close();
  useDocumentPropertiesStore.getState().open();
}

function SelectionColorRow() {
  const selectionColor = useConfigStore((s) => s.config.editor.selectionColor);
  const setSelectionColor = useConfigStore((s) => s.setSelectionColor);

  return (
    <Row
      icon={<Paintbrush className="h-4 w-4" />}
      label="Selection Color"
      description="Background of the painted text selection; always painted translucent so text stays readable"
    >
      <ColorPickerButton
        label="Selection Color"
        solidSwatch
        hideReset
        defaultColor={selectionColor}
        onChange={(color) => setSelectionColor(color ?? '')}
      />
    </Row>
  );
}

/** The user identity — the default author for new documents' metadata. */
function IdentityRow() {
  const author = useConfigStore((s) => s.config.identity.author);
  const setIdentityAuthor = useConfigStore((s) => s.setIdentityAuthor);

  return (
    <Row
      icon={<User className="h-4 w-4" />}
      label="Author Name"
      description={
        <>
          {'Default author for new documents\u2019 metadata; each document can override it in '}
          <button
            type="button"
            className="rounded outline-none underline underline-offset-2 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            onClick={openDocumentProperties}
          >
            Review &gt; Document Properties
          </button>
        </>
      }
    >
      <Input
        className="h-8 w-48"
        aria-label="Author name"
        placeholder="Your name"
        value={author}
        onChange={(e) => setIdentityAuthor(e.target.value)}
      />
    </Row>
  );
}

export function GeneralPanel() {
  const theme = useConfigStore((s) => s.config.theme);
  const setTheme = useConfigStore((s) => s.setTheme);
  // #102 — the accent picker rides the store's writer (retunes --primary,
  // the window icon, the favicon).
  const accent = useConfigStore((s) => s.config.accent);
  const setAccent = useConfigStore((s) => s.setAccent);
  const useFloatingToolbar = useConfigStore((s) => s.config.useFloatingToolbar);
  const setUseFloatingToolbar = useConfigStore((s) => s.setUseFloatingToolbar);
  const pasteOnMiddleClick = useConfigStore((s) => s.config.editor.pasteOnMiddleClick);
  const setPasteOnMiddleClick = useConfigStore((s) => s.setPasteOnMiddleClick);
  const developerMode = useConfigStore((s) => s.config.developerMode);
  // The default export folder ('' = the OS dialog's default).
  const downloadsDir = useConfigStore((s) => s.config.downloadsDir);
  const setDownloadsDir = useConfigStore((s) => s.setDownloadsDir);
  // The always-ask trigger (Shift default / Ctrl+⌘).
  const trigger = useConfigStore((s) => s.config.pdfAlwaysAskTrigger);
  const setPdfAlwaysAskTrigger = useConfigStore((s) => s.setPdfAlwaysAskTrigger);
  const triggerLabel = trigger === 'ctrl' ? 'Ctrl/' : 'Shift+';
  const setDeveloperMode = useConfigStore((s) => s.setDeveloperMode);
  // #100 — the window controls' side (inert on macOS — native lights).
  const windowControlsSide = useConfigStore((s) => s.config.windowControlsSide);
  const setWindowControlsSide = useConfigStore((s) => s.setWindowControlsSide);
  // Enabling must be explicit — devtools can inspect and mutate anything.
  const [developerWarningOpen, setDeveloperWarningOpen] = useState(false);

  return (
    <div className="flex flex-col">
      <SettingsSection id="appearance" title="Appearance">
        {/* #102 — theme options; System follows the OS live. */}
        <Row icon={<Sun className="h-4 w-4" />} label="Theme" description="Light, dark, or following your system">
          <div className="flex gap-1" role="group" aria-label="Theme">
            {([
              { value: 'light' as const, label: 'Light', icon: Sun },
              { value: 'dark' as const, label: 'Dark', icon: Moon },
              { value: 'system' as const, label: 'System', icon: Monitor },
            ]).map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={theme === option.value ? 'secondary' : 'ghost'}
                className="h-7 gap-1"
                aria-pressed={theme === option.value}
                onClick={() => setTheme(option.value)}
              >
                <option.icon className="h-3.5 w-3.5" />
                {option.label}
              </Button>
            ))}
          </div>
        </Row>
        {/* #102 — accent swatches; the store's writer retunes --primary,
            the window icon, and the favicon. */}
        <Row
          icon={<Paintbrush className="h-4 w-4" />}
          label="Accent color"
          description="Tensor's accent across the app"
        >
          <div className="flex flex-wrap justify-end gap-1.5" role="group" aria-label="Accent color">
            {ACCENTS.map((option) => (
              <Tooltip key={option.id}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`${option.label} accent`}
                      aria-pressed={accent === option.id}
                      data-testid={`accent-${option.id}`}
                      onClick={() => setAccent(option.id as AccentId)}
                      className={cn(
                        'h-6 w-6 rounded-full border border-black/10 transition-transform outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 hover:scale-110',
                        accent === option.id &&
                          'ring-2 ring-ring ring-offset-2 ring-offset-background',
                      )}
                      style={{ backgroundColor: option.hex }}
                    />
                  }
                />
                <TooltipContent>{option.label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </Row>
        <Row
          icon={<PanelRightClose className="h-4 w-4" />}
          label="Window buttons"
          description={
            isMacOS()
              ? 'macOS keeps its native traffic lights (left) — this setting applies to Linux and Windows'
              : 'Which side of the title bar the minimize/maximize/close buttons sit on'
          }
        >
          <div className="flex gap-1" role="group" aria-label="Window button placement">
            {(['left', 'right'] as const).map((option) => (
              <Button
                key={option}
                size="sm"
                variant={windowControlsSide === option ? 'secondary' : 'ghost'}
                className="h-7 gap-1 capitalize"
                aria-pressed={windowControlsSide === option}
                disabled={isMacOS()}
                onClick={() => setWindowControlsSide(option)}
              >
                {option === 'left' ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelRightClose className="h-3.5 w-3.5" />}
                {option}
              </Button>
            ))}
          </div>
        </Row>
        <SelectionColorRow />
      </SettingsSection>

      <SettingsSection id="user" title="User">
        <IdentityRow />
      </SettingsSection>

      <SettingsSection id="editor" title="Editor">
        <Row icon={<Type className="h-4 w-4" />} label="Floating Toolbar" description="Show a formatting toolbar near text selections">
          <Switch checked={useFloatingToolbar} onCheckedChange={setUseFloatingToolbar} />
        </Row>
      </SettingsSection>

      <SettingsSection id="behavior" title="Behavior">
        <Row
          icon={<Mouse className="h-4 w-4" />}
          label="Paste on Middle Click"
          description="Middle-click pastes the clipboard at the clicked position"
        >
          <Switch
            checked={pasteOnMiddleClick}
            onCheckedChange={(checked: boolean) => setPasteOnMiddleClick(checked)}
          />
        </Row>
      </SettingsSection>


      <SettingsSection id="downloads" title="Downloads">
        <Row
          icon={<FolderOpen className="h-4 w-4" />}
          label="Default Export Folder"
          description={
            downloadsDir
              ? `PDF exports save directly here (${triggerLabel}click Save as PDF to pick a location)`
              : `PDF exports ask where to save (pick a folder to skip the dialog)`
          }
        >
          <div className="flex items-center gap-2">
            {downloadsDir && (
              <Button variant="outline" size="sm" onClick={() => setDownloadsDir('')}>
                Reset
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const dir = await openDialog({ directory: true, multiple: false });
                if (typeof dir === 'string') setDownloadsDir(dir);
              }}
            >
              Choose…
            </Button>
          </div>
        </Row>
        <Row
          icon={<FolderOpen className="h-4 w-4" />}
          label="Always-Ask Trigger"
          description={`The modifier that makes Save as PDF prompt for a location (${triggerLabel}click)`}
        >
          <div className="flex items-center gap-1">
            <Button
              variant={trigger === 'shift' ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setPdfAlwaysAskTrigger('shift')}
            >
              Shift
            </Button>
            <Button
              variant={trigger === 'ctrl' ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setPdfAlwaysAskTrigger('ctrl')}
            >
              Ctrl / ⌘
            </Button>
          </div>
        </Row>
      </SettingsSection>

      <SettingsSection id="advanced" title="Advanced">
        <Row
          icon={<Terminal className="h-4 w-4" />}
          label="Developer Mode"
          description="Adds Reload and Inspect Element to the right-click menu"
        >
          <Switch
            checked={developerMode}
            onCheckedChange={(checked: boolean) => {
              if (checked) setDeveloperWarningOpen(true);
              else setDeveloperMode(false);
            }}
          />
        </Row>
      </SettingsSection>

      <Dialog open={developerWarningOpen} onOpenChange={setDeveloperWarningOpen}>
        <DialogContent
          // The popup's overlay must clear the already-open Settings
          // dialog's z-50 popup — the frosted layer dims the app,
          // never the card.
          className={`sm:max-w-sm ${STACKED_DIALOG_CONTENT}`}
          overlayClassName={STACKED_DIALOG_OVERLAY}
        >
          <DialogHeader>
            <DialogTitle>Enable Developer Mode?</DialogTitle>
            <DialogDescription>
              This exposes browser-style developer tools (Reload, Inspect Element) in the
              right-click menu. Inspecting and editing the app's internals can break it —
              documents may need reopening and the app may misbehave until reloaded. Only
              enable this if you know what you're doing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeveloperWarningOpen(false)}>
              Cancel
            </Button>
            <Button
              data-testid="developer-mode-accept"
              variant="destructive"
              onClick={() => {
                setDeveloperMode(true);
                setDeveloperWarningOpen(false);
              }}
            >
              I understand, enable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
