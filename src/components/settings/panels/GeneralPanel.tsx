import { useState, type ReactNode } from 'react';
import { Moon, Type, Paintbrush, User, Mouse, Terminal } from 'lucide-react';
import { useConfigStore } from '@/lib/config/store';
import { useSettingsDialogStore } from '@/lib/settings/store';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ColorPickerButton } from '@/components/layout/ribbon/ColorPickerButton';
import { SettingsSection } from '@/components/settings/SettingsSection';
import type { SettingsSectionDefinition } from '@/lib/settings/types';

export const GENERAL_PANEL_SECTIONS: SettingsSectionDefinition[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'user', label: 'User' },
  { id: 'editor', label: 'Editor' },
  { id: 'behavior', label: 'Behavior' },
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

/** M-META: the "Review > Document Properties" reference in the
 *  identity row is LIVE — it closes Settings and opens the dialog for
 *  the current document. */
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

/** M-META: the user identity — the default author for new documents'
 *  metadata (see the config schema note for the onboarding plan). */
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
  const useFloatingToolbar = useConfigStore((s) => s.config.useFloatingToolbar);
  const setUseFloatingToolbar = useConfigStore((s) => s.setUseFloatingToolbar);
  const pasteOnMiddleClick = useConfigStore((s) => s.config.editor.pasteOnMiddleClick);
  const setPasteOnMiddleClick = useConfigStore((s) => s.setPasteOnMiddleClick);
  const developerMode = useConfigStore((s) => s.config.developerMode);
  const setDeveloperMode = useConfigStore((s) => s.setDeveloperMode);
  // The enabling warning: turning Developer Mode ON must be ACCEPTED,
  // never incidental (devtools can inspect and mutate anything).
  const [developerWarningOpen, setDeveloperWarningOpen] = useState(false);

  return (
    <div className="flex flex-col">
      <SettingsSection id="appearance" title="Appearance">
        <Row icon={<Moon className="h-4 w-4" />} label="Dark Mode" description="Switch between light and dark appearance">
          <Switch checked={theme === 'dark'} onCheckedChange={(checked: boolean) => setTheme(checked ? 'dark' : 'light')} />
        </Row>
      </SettingsSection>

      <SettingsSection id="user" title="User">
        <IdentityRow />
      </SettingsSection>

      <SettingsSection id="editor" title="Editor">
        {/* One wrapper = one divide-y child: no border between these two rows. */}
        <div>
          <Row icon={<Type className="h-4 w-4" />} label="Floating Toolbar" description="Show a formatting toolbar near text selections">
            <Switch checked={useFloatingToolbar} onCheckedChange={setUseFloatingToolbar} />
          </Row>
          <SelectionColorRow />
        </div>
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
          // The POPUP must clear its OWN raised overlay (z-[100]) and
          // everything below it — including the already-open Settings
          // dialog's z-50 popup — so the frosted layer dims/blurs the
          // app, never the card itself.
          className="sm:max-w-sm z-[110]"
          overlayClassName="z-[100] bg-black/30 backdrop-blur-lg"
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
