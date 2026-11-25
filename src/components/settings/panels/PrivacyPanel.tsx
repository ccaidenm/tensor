import type { ReactNode } from 'react';
import { Globe, Link2, SpellCheck, Type } from 'lucide-react';
import { useConfigStore } from '@/lib/config/store';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { useTranslateStore } from '@/lib/editor/translate/store';
import { providerDestination } from '@/lib/editor/translate/client';
import type { SettingsSectionDefinition } from '@/lib/settings/types';

export const PRIVACY_PANEL_SECTIONS: SettingsSectionDefinition[] = [
  { id: 'link-previews', label: 'Link Previews' },
  { id: 'fonts', label: 'Fonts' },
  { id: 'spell-check', label: 'Spell Check' },
  { id: 'translate', label: 'Translate' },
  { id: 'updates', label: 'Updates' },
];

function Row({ icon, label, description, children }: { icon: ReactNode; label: string; description?: string; children: ReactNode }) {
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

/** The translate posture row: where text goes, stated plainly. The
 *  provider/key are managed in Proofing; this row opens the setup. */
function TranslateRow() {
  const configured = useConfigStore((s) => s.config.translation.configured);
  const provider = useConfigStore((s) => s.config.translation.provider);
  const endpoint = useConfigStore((s) => s.config.translation.endpoint);
  const openSetup = useTranslateStore((s) => s.openSetup);
  const destination = providerDestination(provider, endpoint);

  return (
    <Row
      icon={<Globe className="h-4 w-4" />}
      label="On-demand translation"
      description={
        configured
          ? `The text you translate (a selection or the whole document) is sent to ${destination} each time you press Translate. Nothing is sent otherwise. The provider and key are managed in Proofing.`
          : 'Off by default — nothing is ever sent until you choose a provider (the Translate panel’s setup dialog). Translation is an online feature: the text you choose to translate leaves this device for the provider you configured. LibreTranslate self-hosted is the free, keyless, privacy-first option; Google Cloud and DeepL are commercial APIs.'
      }
    >
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        onClick={openSetup}
        data-testid="privacy-translate-setup"
      >
        {configured ? 'Change provider…' : 'Set up…'}
      </Button>
    </Row>
  );
}

export function PrivacyPanel() {
  const fetchLinkMetadata = useConfigStore((s) => s.config.privacy.fetchLinkMetadata);
  const setFetchLinkMetadata = useConfigStore((s) => s.setFetchLinkMetadata);
  const allowFontCatalogs = useConfigStore((s) => s.config.privacy.allowFontCatalogs);
  const setAllowFontCatalogs = useConfigStore((s) => s.setAllowFontCatalogs);

  return (
    <div className="flex flex-col">
      <SettingsSection id="link-previews" title="Link Previews">
        <Row
          icon={<Link2 className="h-4 w-4" />}
          label="Fetch Link Preview Metadata"
          description="When inserting a hyperlink, fetch the page's title/favicon from the internet to show a live preview. Disabling this means links are never followed until you click them."
        >
          <Switch checked={fetchLinkMetadata} onCheckedChange={setFetchLinkMetadata} />
        </Row>
      </SettingsSection>

      <SettingsSection id="fonts" title="Fonts">
        <Row
          icon={<Type className="h-4 w-4" />}
          label="Allow browsing online font catalogs"
          description="Adds Google Fonts, Font Share, and Fontsource to the font browser's search. While off, the font browser shows only your installed, bundled, and uploaded fonts — nothing requests the network."
        >
          <Switch
            checked={allowFontCatalogs}
            onCheckedChange={setAllowFontCatalogs}
            data-testid="allow-font-catalogs-switch"
          />
        </Row>
      </SettingsSection>

      <SettingsSection id="spell-check" title="Spell Check">
        <Row
          icon={<SpellCheck className="h-4 w-4" />}
          label="Where checking happens"
          description="Spelling and grammar checking are off by default. When enabled, the LOCAL provider runs LanguageTool as a process on this device and never sends anything over the network (loopback only). The ONLINE provider — an explicit choice in the setup dialog — sends your text to LanguageTool's servers for checking. Spelling and grammar are independent toggles (Proofing); the provider, dictionary, and local runtime storage are managed in Proofing. Grammar flags are advisory-blue by default; Accessibility holds the double-line color-blind aid."
        >
          <span />
        </Row>
      </SettingsSection>

      <SettingsSection id="translate" title="Translate">
        <TranslateRow />
      </SettingsSection>

    </div>
  );
}
