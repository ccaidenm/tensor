import type { ReactNode } from 'react';
import { Moon, Type, Paintbrush, User, Accessibility as AccessibilityIcon, Mouse } from 'lucide-react';
import { useConfigStore } from '@/lib/config/store';
import { useSettingsDialogStore } from '@/lib/settings/store';
import { useDocumentPropertiesStore } from '@/lib/document/propertiesStore';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ColorPickerButton } from '@/components/layout/ribbon/ColorPickerButton';
import { SettingsSection } from '@/components/settings/SettingsSection';
import type { SettingsSectionDefinition } from '@/lib/settings/types';

export const GENERAL_PANEL_SECTIONS: SettingsSectionDefinition[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'user', label: 'User' },
  { id: 'editor', label: 'Editor' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'accessibility', label: 'Accessibility' },
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
  const reduceMotion = useConfigStore((s) => s.config.accessibility.reduceMotion);
  const setReduceMotion = useConfigStore((s) => s.setReduceMotion);
  const pasteOnMiddleClick = useConfigStore((s) => s.config.editor.pasteOnMiddleClick);
  const setPasteOnMiddleClick = useConfigStore((s) => s.setPasteOnMiddleClick);

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

      <SettingsSection id="accessibility" title="Accessibility">
        <Row
          icon={<AccessibilityIcon className="h-4 w-4" />}
          label="Reduce Motion"
          description="Disable UI animations (panels, transitions)"
        >
          <div className="flex gap-1">
            {(['system', 'on', 'off'] as const).map((opt) => (
              <Button
                key={opt}
                size="sm"
                variant={reduceMotion === opt ? 'secondary' : 'ghost'}
                onClick={() => setReduceMotion(opt)}
                className="capitalize"
              >
                {opt}
              </Button>
            ))}
          </div>
        </Row>
      </SettingsSection>
    </div>
  );
}
