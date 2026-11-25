import { RibbonGroup } from "@/components/layout/RibbonGroup";
import { IconButton } from "../../../IconButton";
import { FileSearchCorner } from "lucide-react";
import { useSidebarStore } from "@/lib/layout/sidebarStore";

export function SearchGroup() {
  return (
    <RibbonGroup>
      <IconButton label="Find & Replace" icon={<FileSearchCorner size={16} />} shortcutId='find' onClick={() => {useSidebarStore.getState().open('search', 'right')}} />
      {/* #101 — "Find in All Open Documents" returns with multi-window. */}

    </RibbonGroup>
  );
}
