import { RibbonGroup } from "@/components/layout/RibbonGroup";
import { IconButton } from "../../../IconButton";
import { getCommand } from "@/lib/commands/registry";
import { PersonStanding } from "lucide-react";

/**
 * M-A11Y — the Review tab's Accessibility Check trigger. Born as a
 * disabled stub with the Review tab itself; now wired to the one
 * command body (the palette + the menu + this button can never drift
 * — the registry's law): opens the docked Accessibility Check panel,
 * whose scan runs live while open.
 */
export function AccessibilityGroup() {
  return (
    <RibbonGroup>
      <IconButton
        label="Accessibility Check"
        icon={<PersonStanding size={16} />}
        onClick={() => {
          void getCommand("accessibilityCheck")?.run();
        }}
      />
    </RibbonGroup>
  );
}
