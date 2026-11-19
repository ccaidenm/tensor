import { RibbonGroup } from "@/components/layout/RibbonGroup";
import { NonPrintingCharsToggle } from "../NPCToggle";
import { BreakMarksToggle } from "../BreakMarksToggle";
import { IconButton } from "../../../IconButton";
import { Sparkles } from "lucide-react";
import { getCommand } from "@/lib/commands/registry";

/**
 * The Review tab's display toggles + the Document Statistics entry —
 * born opening the stats DIALOG; the statistics surface is now the
 * docked dashboard sidebar (cards + region breakdown), so this button
 * routes to the ONE command body (the registry's law — the palette and
 * this button can never drift).
 */
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
