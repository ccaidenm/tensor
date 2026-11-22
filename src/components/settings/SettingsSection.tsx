import { forwardRef, type ReactNode } from 'react';

interface SettingsSectionProps {
  id: string;
  title: string;
  children: ReactNode;
}

// One labeled group of settings inside a panel. `data-section-id` keys
// both useActiveSection's IntersectionObserver and the nav's scroll handler —
// a data attribute, not an `id` (only one panel is mounted at a time).
export const SettingsSection = forwardRef<HTMLDivElement, SettingsSectionProps>(function SettingsSection(
  { id, title, children },
  ref,
) {
  return (
    <div ref={ref} data-section-id={id} className="mb-8 scroll-mt-2 last:mb-0">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{title}</h3>
      <div className="flex flex-col divide-y divide-border">{children}</div>
    </div>
  );
});
