import { Ruler, PanelTop, Droplet, Superscript, SquareDashed, MessageSquareText } from 'lucide-react';
import { RibbonGroup } from '../../../RibbonGroup';
import { IconButton } from '../../../IconButton';
import { useConfigStore } from '@/lib/config/store';
// M-PRINT (#43): View > Print Preview — the preview modal's menu entry
// (the palette command + Ctrl+P are its siblings; one registry body).

export function ShowGroup() {
  // M-IMAGES-1: the Captions DISPLAY toggle (the NPC precedent) —
  // presentation-only ink, both modes; the model (and ToF's caption
  // reads) is untouched.
  const showCaptions = useConfigStore((s) => s.config.editor.showCaptions);
  const setShowCaptions = useConfigStore((s) => s.setShowCaptions);
  // M-HEADER-FOOTER: the bands DISPLAY toggle (the captions precedent
  // again — presentation-only; the settings round-trip in .wpdoc
  // regardless). Pages mode only (no page geometry to band otherwise).
  const showHeadersFooters = useConfigStore((s) => s.config.editor.showHeadersFooters);
  const setShowHeadersFooters = useConfigStore((s) => s.setShowHeadersFooters);
  // #WATERMARK: the display toggle (the captions NPC precedent).
  const showWatermark = useConfigStore((s) => s.config.editor.showWatermark);
  const setShowWatermark = useConfigStore((s) => s.setShowWatermark);
  // M-RULER: the ruler is a PAGINATED-mode surface (it rules real page
  // geometry) — like the page-setup controls, it disables (never
  // disappears) in pageless mode. The single button toggles BOTH bars
  // (the command palette owns the per-axis granularity).
  const showHorizontalRuler = useConfigStore((s) => s.config.editor.showHorizontalRuler);
  const showVerticalRuler = useConfigStore((s) => s.config.editor.showVerticalRuler);
  const setBothRulers = useConfigStore((s) => s.setBothRulers);
  const isPageless =
    useConfigStore((s) => s.config.editor.defaultPageLayout) !== 'Pages';

  return (
    <RibbonGroup>
      <IconButton
        label="Show Captions"
        icon={<MessageSquareText size={16} />}
        active={showCaptions}
        onClick={() => setShowCaptions(!showCaptions)}
      />
      <IconButton
        label="Show Rulers"
        icon={<Ruler size={16} />}
        active={showHorizontalRuler || showVerticalRuler}
        disabled={isPageless}
        onClick={() => setBothRulers(!(showHorizontalRuler || showVerticalRuler))}
      />
      <IconButton
        label="Show Margins"
        icon={<SquareDashed size={16} />}
        onClick={() => {}}
        disabled
      />
      <IconButton
        label="Show Headers & Footers"
        icon={<PanelTop size={16} />}
        active={showHeadersFooters}
        onClick={() => setShowHeadersFooters(!showHeadersFooters)}
        disabled={isPageless}
      />
      {/* #WATERMARK — the display toggle (the captions NPC precedent):
          view-only ink; the document's watermark setting never moves.
          Pages mode only — pageless has no sheets to paint. */}
      <IconButton
        label="Show Watermarks"
        icon={<Droplet size={16} />}
        active={showWatermark}
        onClick={() => setShowWatermark(!showWatermark)}
        disabled={isPageless}
      />
      <IconButton
        label="Show Footnotes & Endnotes"
        icon={<Superscript size={16} />}
        onClick={() => {}}
        disabled
      />
    </RibbonGroup>
  );
}
