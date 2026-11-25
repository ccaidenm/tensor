import { Droplet } from "lucide-react";
import { useDocumentStore } from "@/lib/document/store";
import { RibbonGroup } from "@/components/layout/RibbonGroup";
import { IconButton } from "../../../IconButton";
import { getCommand } from "@/lib/commands/registry";

/** The Watermark entry lives on Insert — "you insert a watermark." */
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
