import { RibbonGroup } from "@/components/layout/RibbonGroup";
import { IconButton } from "../../../IconButton";
import { getCommand } from "@/lib/commands/registry";
import { PersonStanding } from "lucide-react";

/** The Review tab's Accessibility Check trigger — opens the docked
 *  panel, whose scan runs live while open. */
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
