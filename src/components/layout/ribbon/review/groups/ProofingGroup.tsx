import { RibbonGroup } from "@/components/layout/RibbonGroup";
import { IconButton } from "../../../IconButton";
import { getCommand } from "@/lib/commands/registry";
import { BookA, Info, Languages, SpellCheck } from "lucide-react";
import { useDocumentPropertiesStore } from "@/lib/document/propertiesStore";
import { useConfigStore } from "@/lib/config/store";
import { spellCheckActive } from "@/lib/config/schema";
import { useSpellStore } from "@/lib/editor/spell/store";

export function ProofingGroup() {
  const spell = useConfigStore((s) => s.config.spellCheck);
  const setSpellCheckEnabled = useConfigStore((s) => s.setSpellCheckEnabled);
  const openSetup = useSpellStore((s) => s.openSetup);
  const openDictionary = useSpellStore((s) => s.openDictionary);

  /** MASTER semantic: the ribbon button flips BOTH features (the
   *  common intent — "spell check off"); the per-feature switches live
   *  in Settings → Proofing. Active = either feature on. */
  function toggleSpellCheck() {
    if (!spell.configured) {
      openSetup();
      return;
    }
    setSpellCheckEnabled(!spellCheckActive(spell));
  }

  return (
    <RibbonGroup>
      <IconButton
        label={spell.configured ? "Spelling & Grammar" : "Spelling & Grammar (set up first)"}
        icon={<SpellCheck size={16} />}
        active={spellCheckActive(spell)}
        onClick={toggleSpellCheck}
        shortcutId="toggleSpellCheck"
      />
      <IconButton label="Dictionary" icon={<BookA size={16} />} onClick={openDictionary} />
      {/* TRANSLATE — born a disabled stub with the ProofingGroup; now
          wired to the ONE command body (the palette + this button can
          never drift — the registry's law): opens the docked Translate
          panel, whose runs are on-demand and consented (the setup
          dialog gates the first use). */}
      <IconButton label="Translate" icon={<Languages size={16} />} onClick={() => { void getCommand('translateSidebar')?.run(); }} />
      <IconButton
        label="Document Properties"
        icon={<Info size={16} />}
        onClick={() => useDocumentPropertiesStore.getState().open()}
      />
    </RibbonGroup>
  );
}