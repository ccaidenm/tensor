import { useMemo, useState, type ReactNode } from 'react';
import { t } from '@/lib/i18n';
import { Bug, Heart, Lightbulb, ScrollText, Users, ExternalLink, ChevronDown, FolderGit2 } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { TensorLogo } from '@/components/icons/TensorIcon';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { SettingsSection } from '@/components/settings/SettingsSection';
import type { SettingsSectionDefinition } from '@/lib/settings/types';
import licensesData from '@/generated/licenses.json';
import { APP_VERSION } from '@/generated/version';
import { cn } from 'cn';

export const ABOUT_PANEL_SECTIONS: SettingsSectionDefinition[] = [
  { id: 'info', label: 'Info' },
  { id: 'links', label: 'Links' },
  { id: 'licenses', label: 'Third-Party Licenses' },
];

// #97 — the repo is the app; the version is single-sourced from
// tauri.conf.json at build time (src/generated/version.ts).
const GITHUB_REPO_URL = 'https://github.com/ccaidenm/tensor';
const LICENSE = 'AGPL-3.0';

interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  repository: string | null;
}
const licenses = licensesData as LicenseEntry[];

function LinkRow({ icon, label, description, onClick }: { icon: ReactNode; label: string; description?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group inline-flex w-fit items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="block text-xs text-muted-foreground">{description}</span>}
      </span>
    </button>
  );
}

export function AboutPanel() {
  const [licenseQuery, setLicenseQuery] = useState('');
  const [licensesOpen, setLicensesOpen] = useState(false);

  const filteredLicenses = useMemo(() => {
    if (!licenseQuery.trim()) return licenses;
    const q = licenseQuery.toLowerCase();
    return licenses.filter((entry) => entry.name.toLowerCase().includes(q) || entry.license.toLowerCase().includes(q));
  }, [licenseQuery]);

  return (
    <div className="flex flex-col">
      <SettingsSection id="info" title={t('about.info.title')}>
        <div className="flex items-center gap-4 py-2">
          <TensorLogo size={48} className="text-primary"/>
          <div>
            <div className="font-heading text-2xl font-semibold">Tensor</div>
            <div className="text-sm text-muted-foreground">
              {t('about.info.version', { version: APP_VERSION, license: LICENSE })}
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection id="links" title={t('about.links.title')}>
        <div className="flex flex-col gap-0.5">
          <LinkRow
            icon={<FolderGit2 className="h-4 w-4" />}
            label={t('about.links.github.label')}
            description={t('about.links.github.description')}
            onClick={() => openUrl(GITHUB_REPO_URL)}
          />
          <LinkRow icon={<Bug className="h-4 w-4" />} label={t('about.links.bug.label')} onClick={() => openUrl(`${GITHUB_REPO_URL}/issues/new?labels=bug`)} />
          <LinkRow
            icon={<Lightbulb className="h-4 w-4" />}
            label={t('about.links.feature.label')}
            onClick={() => openUrl(`${GITHUB_REPO_URL}/issues/new?labels=enhancement`)}
          />
          <LinkRow
            icon={<Users className="h-4 w-4" />}
            label={t('about.links.contributors.label')}
            description={t('about.links.contributors.description')}
            onClick={() => openUrl(`${GITHUB_REPO_URL}/graphs/contributors`)}
          />
          <LinkRow
            icon={<ScrollText className="h-4 w-4" />}
            label={t('about.links.license.label')}
            description={LICENSE}
            onClick={() => openUrl(`${GITHUB_REPO_URL}/blob/main/LICENSE`)}
          />
        </div>
      </SettingsSection>

      <SettingsSection id="licenses" title={t('about.licenses.title')}>
        <div>
          <p className="mb-3 text-xs text-muted-foreground">
            {t('about.licenses.intro', { count: licenses.length })}{' '}
            {/* #97 — the heart speaks the accent (text-primary follows the brand token). */}
            <Heart
              className="inline h-3.5 w-3.5 fill-current text-primary align-text-bottom"
              aria-hidden="true"
            />
          </p>

          <Collapsible open={licensesOpen} onOpenChange={setLicensesOpen}>
            <CollapsibleTrigger
              render={
                <Button variant="outline" size="sm" className="gap-1.5">
                  {licensesOpen ? t('about.licenses.hide') : t('about.licenses.show')}
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', licensesOpen && 'rotate-180')} />
                </Button>
              }
            />

            <CollapsibleContent className="pt-3">
              <Input
                value={licenseQuery}
                onChange={(e) => setLicenseQuery(e.target.value)}
                placeholder={t('about.licenses.filter')}
                className="mb-3 h-8"
              />

              <div className="flex flex-col divide-y divide-border">
                {filteredLicenses.map((entry) => (
                  <div key={`${entry.name}@${entry.version}`} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {entry.name} <span className="font-normal text-muted-foreground">v{entry.version}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">{entry.license}</div>
                    </div>
                    {entry.repository && (
                      <button
                        type="button"
                        onClick={() => openUrl(entry.repository!)}
                        className="flex flex-none items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {t('about.licenses.repo')}
                      </button>
                    )}
                  </div>
                ))}
                {filteredLicenses.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">{t('about.licenses.noMatches')}</div>}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </SettingsSection>
    </div>
  );
}
