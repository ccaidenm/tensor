import { Droplet } from "lucide-react";
import { useDocumentStore } from "@/lib/document/store";
import { RibbonGroup } from "@/components/layout/RibbonGroup";
import { IconButton } from "../../../IconButton";
import { getCommand } from "@/lib/commands/registry";

/**
 * #WATERMARK — the Insert tab's entry ("you INSERT a watermark", the
 * issue's framing): opens the docked Watermark panel through the ONE
 * command body (the registry law — ribbon, palette, and any future menu
 * can never drift).
 */
export function WatermarkGroup() {
  const editor = useDocumentStore((s) => s.editor);
  if (!editor) return null;
  return (
    <RibbonGroup>
      <IconButton
        label="Watermark"
        icon={<Droplet size={16} />}
        onClick={() => {
          void getCommand("watermarkPanel")?.run();
        }}
      />
    </RibbonGroup>
  );
}
