import { RibbonGroup } from "@/components/layout/RibbonGroup";
import { NonPrintingCharsToggle } from "../NPCToggle";
import { BreakMarksToggle } from "../BreakMarksToggle";
import { IconButton } from "../../../IconButton";
import { Sparkles } from "lucide-react";
import { useDocumentPropertiesStore } from "@/lib/document/propertiesStore";

export function DisplayGroup() {
  return (
    <RibbonGroup showSeparator={false}>
      <NonPrintingCharsToggle />
      <BreakMarksToggle />
      <IconButton
        label="Document Statistics"
        icon={<Sparkles size={16} />}
        onClick={() => useDocumentPropertiesStore.getState().openStats()}
      />
    </RibbonGroup>
  );
}
