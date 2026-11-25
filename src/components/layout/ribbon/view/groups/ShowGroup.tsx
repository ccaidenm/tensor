import { Ruler, PanelTop, Droplet, SquareDashed, MessageSquareText } from 'lucide-react';
import { RibbonGroup } from '../../../RibbonGroup';
import { IconButton } from '../../../IconButton';
import { useConfigStore } from '@/lib/config/store';
import { useViewMode } from '@/lib/document/useViewMode';

export function ShowGroup() {
  // Captions display toggle — presentation-only ink; the model is untouched.
  const showCaptions = useConfigStore((s) => s.config.editor.showCaptions);
  const setShowCaptions = useConfigStore((s) => s.setShowCaptions);
  // Headers/footers display toggle — presentation-only (settings
  // round-trip in .wpdoc); pages mode only.
  const showHeadersFooters = useConfigStore((s) => s.config.editor.showHeadersFooters);
  const setShowHeadersFooters = useConfigStore((s) => s.setShowHeadersFooters);
  const showWatermark = useConfigStore((s) => s.config.editor.showWatermark);
  const setShowWatermark = useConfigStore((s) => s.setShowWatermark);
  const showBoundaryContent = useConfigStore((s) => s.config.editor.showBoundaryContent);
  const setShowBoundaryContent = useConfigStore((s) => s.setShowBoundaryContent);
  // The ruler rules real page geometry — it disables (never disappears)
  // in pageless. The button toggles both bars (per-axis lives in the palette).
  const showHorizontalRuler = useConfigStore((s) => s.config.editor.showHorizontalRuler);
  const showVerticalRuler = useConfigStore((s) => s.config.editor.showVerticalRuler);
  const setBothRulers = useConfigStore((s) => s.setBothRulers);
  const isPageless = useViewMode() !== 'Pages';

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
      {/* Boundary content — the outside space around the sheets (the
          comments gutter). A persisted view setting, on by default,
          both modes; hiding never reflows the document. */}
      <IconButton
        label="Show Boundary Content"
        icon={<SquareDashed size={16} />}
        active={showBoundaryContent}
        onClick={() => setShowBoundaryContent(!showBoundaryContent)}
      />
      <IconButton
        label="Show Headers & Footers"
        icon={<PanelTop size={16} />}
        active={showHeadersFooters}
        onClick={() => setShowHeadersFooters(!showHeadersFooters)}
        disabled={isPageless}
      />
      {/* Watermark display — view-only ink (the document's watermark
          setting never moves); pages mode only. */}
      <IconButton
        label="Show Watermarks"
        icon={<Droplet size={16} />}
        active={showWatermark}
        onClick={() => setShowWatermark(!showWatermark)}
        disabled={isPageless}
      />
    </RibbonGroup>
  );
}
