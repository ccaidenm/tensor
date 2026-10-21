import { RibbonGroup } from "@/components/layout/RibbonGroup";
import { IconButton } from "../../../IconButton";
import { BookA, Info, Languages, SpellCheck } from "lucide-react";
import { useDocumentPropertiesStore } from "@/lib/document/propertiesStore";
import { useConfigStore } from "@/lib/config/store";
import { useSpellStore } from "@/lib/editor/spell/store";

export function ProofingGroup() {
  const enabled = useConfigStore((s) => s.config.spellCheck.enabled);
  const configured = useConfigStore((s) => s.config.spellCheck.configured);
  const setSpellCheckEnabled = useConfigStore((s) => s.setSpellCheckEnabled);
  const openSetup = useSpellStore((s) => s.openSetup);
  const openDictionary = useSpellStore((s) => s.openDictionary);

  /** The consent gate: the FIRST enable goes through the setup dialog
   *  (provider choice + the privacy/storage trade-offs); after that
   *  the button is a plain toggle. */
  function toggleSpellCheck() {
    if (!configured) {
      openSetup();
      return;
    }
    setSpellCheckEnabled(!enabled);
  }

  return (
    <RibbonGroup>
      <IconButton
        label={configured ? "Spelling & Grammar" : "Spelling & Grammar (set up first)"}
        icon={<SpellCheck size={16} />}
        active={enabled}
        onClick={toggleSpellCheck}
        shortcutId="toggleSpellCheck"
      />
      <IconButton label="Dictionary" icon={<BookA size={16} />} onClick={openDictionary} />
      <IconButton label="Translate" icon={<Languages size={16} />} onClick={() => { }} disabled />
      <IconButton
        label="Document Properties"
        icon={<Info size={16} />}
        onClick={() => useDocumentPropertiesStore.getState().open()}
      />
    </RibbonGroup>
  );
}
