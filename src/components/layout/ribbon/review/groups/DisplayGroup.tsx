import { RibbonGroup } from "@/components/layout/RibbonGroup";
import { NonPrintingCharsToggle } from "../NPCToggle";
import { BreakMarksToggle } from "../BreakMarksToggle";
import { IconButton } from "../../../IconButton";
import { Sparkles } from "lucide-react";
import { getCommand } from "@/lib/commands/registry";

/** The Review tab's display toggles + Document Statistics, which opens
 *  the docked statistics dashboard. */
export function DisplayGroup() {
  return (
    <RibbonGroup showSeparator={false}>
      <NonPrintingCharsToggle />
      <BreakMarksToggle />
      <IconButton
        label="Document Statistics"
        icon={<Sparkles size={16} />}
        onClick={() => {
          void getCommand("statisticsSidebar")?.run();
        }}
      />
    </RibbonGroup>
  );
}
