import type { ReactNode } from 'react';
import { Accessibility as AccessibilityIcon, SpellCheck } from 'lucide-react';
import { useConfigStore } from '@/lib/config/store';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { SettingsSection } from '@/components/settings/SettingsSection';
import type { SettingsSectionDefinition } from '@/lib/settings/types';

export const ACCESSIBILITY_PANEL_SECTIONS: SettingsSectionDefinition[] = [
  { id: 'motion', label: 'Motion' },
  { id: 'visual-cues', label: 'Visual Cues' },
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

export function AccessibilityPanel() {
  const reduceMotion = useConfigStore((s) => s.config.accessibility.reduceMotion);
  const setReduceMotion = useConfigStore((s) => s.setReduceMotion);
  const grammarDoubleLine = useConfigStore((s) => s.config.accessibility.grammarDoubleLine);
  const setGrammarDoubleLine = useConfigStore((s) => s.setGrammarDoubleLine);

  return (
    <div className="flex flex-col">
      <SettingsSection id="motion" title="Motion">
        <Row
          icon={<AccessibilityIcon className="h-4 w-4" />}
          label="Reduce Motion"
          description="Disable UI animations (panels, transitions)"
        >
          <div className="flex gap-1" data-testid="a11y-reduce-motion">
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

      <SettingsSection id="visual-cues" title="Visual Cues">
        <Row
          icon={<SpellCheck className="h-4 w-4" />}
          label="Double-Line Grammar Flags"
          description="Flag grammar issues with a double underline in addition to the advisory-blue color — a non-color cue that reads without relying on hue. Spelling stays single-line red; this does not change either feature's scope."
        >
          <Switch
            checked={grammarDoubleLine}
            onCheckedChange={setGrammarDoubleLine}
            data-testid="a11y-grammar-double-line"
          />
        </Row>
      </SettingsSection>
    </div>
  );
}