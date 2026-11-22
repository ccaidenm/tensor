import { useEffect, useState } from 'react';
import { useEditorState } from '@tiptap/react';
import { ImagePlus, Percent, RotateCcw, Scaling, X } from 'lucide-react';
import { useDocumentStore } from '@/lib/document/store';
import { useSidebarStore } from '@/lib/layout/sidebarStore';
import { applyPageSetup, sectionAtCaret } from '@/lib/editor/sections';
import { registerImageFromPicker } from '@/lib/media/insert';
import {
  WATERMARK_DEFAULT_COLOR,
  WATERMARK_DEFAULT_IMAGE_ROTATION,
  WATERMARK_DEFAULT_OPACITY,
  WATERMARK_DEFAULT_SCALE,
  WATERMARK_DEFAULT_TEXT_ROTATION,
} from '@/lib/paginated/watermark';
import type { WatermarkSettings } from '@/lib/document/pageSetup';
import { toast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ColorPickerButton } from '@/components/layout/ribbon/ColorPickerButton';
import { RibbonIconInput } from '@/components/layout/ribbon/RibbonIconInput';
import { IconButton } from '@/components/layout/IconButton';
import { cn } from 'cn';

/**
 * The docked watermark panel: LIVE-WRITE — every control commits
 * immediately via applyPageSetup's scope arms (each knob = one co-undo
 * step), and the page behind the open panel IS the preview (paint-only
 * ink: a commit re-renders without a relayout, no flicker). Scope:
 * Whole document / This section — the section arm writes the caret's
 * section's holder with the setup verbatim.
 */

const PRESETS = ['ASAP', 'CONFIDENTIAL', 'DO NOT COPY', 'DRAFT', 'SAMPLE'];

/** Word's preset row — one click = the classic words. */
function PresetChips({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {PRESETS.map((preset) => (
        <Button
          key={preset}
          size="sm"
          variant="secondary"
          className="h-6 px-2 text-xs"
          data-testid={`watermark-preset-${preset.toLowerCase().replace(/\s+/g, '-')}`}
          onClick={() => onPick(preset)}
        >
          {preset}
        </Button>
      ))}
    </div>
  );
}

export function WatermarkPanel() {
  const editor = useDocumentStore((s) => s.editor);
  const pageSetup = useDocumentStore((s) => s.pageSetup);
  const isOpen = useSidebarStore((s) => s.active?.id === 'watermark');

  // Reactivity ticks: docRef for edits, caretFrom for caret moves —
  // selection-only transactions leave the doc reference IDENTICAL
  // (structural sharing), so the caret tick must ride along.
  const docRef = useEditorState({ editor, selector: (ctx) => ctx.editor?.state.doc });
  const caretFrom = useEditorState({ editor, selector: (ctx) => ctx.editor?.state.selection.from });
  void docRef;
  void caretFrom;

  const [scope, setScope] = useState<'document' | 'section'>('document');
  const [textDraft, setTextDraft] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) setScope('document');
  }, [isOpen]);

  // The facts recompute per render: a doc-keyed memo would go STALE on
  // selection-only moves (structural sharing leaves the doc identical).
  // docRef/caretFrom are both referenced to stay load-bearing.
  const facts = editor ? sectionAtCaret(editor, pageSetup) : null;
  // The TARGET's effective watermark: the section's own (break-carried)
  // or the doc default (the store's) — the same chain the view paints.
  const effective: WatermarkSettings | null | undefined =
    scope === 'section' ? (facts?.setup.watermark ?? pageSetup.watermark) : pageSetup.watermark;

  const sectioned = (facts?.total ?? 1) > 1;

  /** ONE commit path — every knob lands here. null = no watermark. */
  const commit = (next: WatermarkSettings | null): void => {
    if (!editor) return;
    if (scope === 'section' && facts) {
      applyPageSetup('section', { ...facts.setup, watermark: next }, {});
    } else {
      applyPageSetup('document', pageSetup, { watermark: next });
    }
  };

  const kind = effective?.kind ?? 'none';

  const commitText = (patch: Partial<WatermarkSettings>): void => {
    const base: WatermarkSettings =
      effective?.kind === 'text'
        ? effective
        : { kind: 'text', text: textDraft ?? 'DRAFT' };
    commit({ ...base, ...patch });
  };

  const commitImage = (patch: Partial<WatermarkSettings>): void => {
    const base: WatermarkSettings =
      effective?.kind === 'image'
        ? effective
        : { kind: 'image', src: '', width: 0, height: 0 };
    commit({ ...base, ...patch });
  };

  const chooseImage = async (): Promise<void> => {
    if (!editor) return;
    setImageBusy(true);
    try {
      // jsdom tests call registerImageBytes directly; the picker is
      // the OS dialog — the ingest variant handles either route.
      const picked = await registerImageFromPicker();
      if (picked) {
        commitImage({ src: picked.src, width: picked.width, height: picked.height });
      } else {
        void toast.add({ title: 'Could not read the image' });
      }
    } finally {
      setImageBusy(false);
    }
  };

  if (!isOpen || !editor) return null;

  // The DRAFT leads while typing: the store value is never "typing in
  // progress", and a store-controlled input would freeze on the
  // committed word (the can't-type bug). Draft wins until commit;
  // commit clears it.
  const storedText = effective?.kind === 'text' ? (effective.text ?? '') : '';
  const textValue = textDraft ?? storedText;
  const fontSizeValue = effective?.kind === 'text' ? (effective.fontSize ?? '') : '';
  const colorValue = effective?.kind === 'text' ? (effective.color ?? '') : '';
  const rotationValue =
    effective?.kind === 'text'
      ? (effective.rotation ?? WATERMARK_DEFAULT_TEXT_ROTATION)
      : (effective?.kind === 'image' ? (effective.rotation ?? WATERMARK_DEFAULT_IMAGE_ROTATION) : 0);
  const opacityValue = (effective?.opacity ?? WATERMARK_DEFAULT_OPACITY) * 100;
  const scaleValue = (effective?.kind === 'image' ? (effective.scale ?? WATERMARK_DEFAULT_SCALE) : WATERMARK_DEFAULT_SCALE) * 100;

  const handleClose = () => {
    useSidebarStore.getState().close();
    editor.commands.focus();
  };

  return (
    <div className="flex h-full flex-col" data-testid="watermark-panel">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Watermark</span>
          {effective && <Badge variant="secondary">On</Badge>}
        </div>
        <IconButton label="Close" icon={<X className="h-4 w-4" />} onClick={handleClose} />
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {/* THE SCOPE — the sections machinery: Whole document merges
            into every break + the store; This section writes the
            caret's section's holder. */}
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-medium text-muted-foreground">Apply to</span>
            {scope === 'section' && facts && (
              <span className="text-xs text-muted-foreground">
                Section {facts.index + 1} of {facts.total}
              </span>
            )}
          </div>
          <div className="flex gap-1" role="group" aria-label="Apply watermark to">
            {(['document', 'section'] as const).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={scope === s ? 'default' : 'secondary'}
                className="h-7 flex-1"
                aria-pressed={scope === s}
                disabled={s === 'section' && !sectioned}
                data-testid={`watermark-scope-${s}`}
                onClick={() => {
                  setScope(s);
                  // The text draft follows the newly targeted spelling.
                  setTextDraft(null);
                }}
              >
                {s === 'document' ? 'Whole document' : 'This section'}
              </Button>
            ))}
          </div>
        </div>

        <Tabs
          value={kind}
          onValueChange={(value: unknown) => {
            if (value === 'none') {
              commit(null);
            } else if (value === 'text') {
              const words = textValue.trim() || 'DRAFT';
              commit({ kind: 'text', text: words });
            } else {
              // 'image': switching before choosing paints nothing —
              // the picker follows immediately.
              void chooseImage();
            }
          }}
          className="mt-4 gap-3"
        >
          <TabsList className="w-full">
            <TabsTrigger value="none" className="text-xs" data-testid="watermark-tab-none">None</TabsTrigger>
            <TabsTrigger value="text" className="text-xs" data-testid="watermark-tab-text">Text</TabsTrigger>
            <TabsTrigger value="image" className="text-xs" data-testid="watermark-tab-image">Image</TabsTrigger>
          </TabsList>

          <TabsContent value="none" className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">
              No watermark{scope === 'section' ? ' on this section' : ''}. Pick Text or Image to add one.
            </span>
          </TabsContent>

          <TabsContent value="text" className="flex flex-col gap-3">
            <PresetChips onPick={(text) => { setTextDraft(null); commitText({ text }); }} />
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Text</span>
              <Input
                data-testid="watermark-text-input"
                value={textValue}
                placeholder="DRAFT"
                onChange={(e) => setTextDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitText({ text: textValue.trim() || 'DRAFT' });
                    setTextDraft(null);
                  }
                }}
                onBlur={() => {
                  // A pending draft commits on blur (the field's own
                  // contract); the store value re-shows after.
                  if (textDraft != null) {
                    commitText({ text: textDraft.trim() || 'DRAFT' });
                    setTextDraft(null);
                  }
                }}
              />
            </div>
            <div className="flex items-end gap-2">
              <RibbonIconInput
                label="Font size (blank = auto)"
                ariaLabel="Watermark font size"
                icon={<Scaling size={12} />}
                value={typeof fontSizeValue === 'number' ? fontSizeValue : 0}
                onCommit={(n) => commitText({ fontSize: n > 0 ? n : undefined })}
                min={0}
                stepAmount={8}
                width="w-24"
                suffix="px"
              />
              <ColorPickerButton
                label="Watermark color"
                icon={<span className="text-sm">A</span>}
                resetLabel="Silver"
                resetColor={WATERMARK_DEFAULT_COLOR}
                defaultColor={colorValue || WATERMARK_DEFAULT_COLOR}
                onChange={(color) => commitText({ color: color ?? WATERMARK_DEFAULT_COLOR })}
              />
            </div>
          </TabsContent>

          <TabsContent value="image" className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-2"
                disabled={imageBusy}
                onClick={() => void chooseImage()}
              >
                <ImagePlus size={14} />
                {effective?.kind === 'image' ? 'Replace image…' : 'Choose image…'}
              </Button>
              {effective?.kind === 'image' && (
                <span className="truncate text-xs text-muted-foreground">
                  {effective.src?.startsWith('media://') ? 'image set' : ''}
                </span>
              )}
            </div>
          </TabsContent>

          {/* Rotation/opacity/scale — shared by both spellings. */}
          <div className={cn('flex flex-wrap items-end gap-2 pt-1', kind === 'none' && 'pointer-events-none opacity-50')}>
            <RibbonIconInput
              label="Rotation"
              ariaLabel="Watermark rotation"
              icon={<RotateCcw size={12} />}
              value={rotationValue}
              onCommit={(n) =>
                (kind === 'image' ? commitImage({ rotation: n }) : commitText({ rotation: n }))
              }
              min={-180}
              stepAmount={15}
              width="w-24"
              suffix="°"
            />
            <RibbonIconInput
              label="Opacity"
              ariaLabel="Watermark opacity"
              icon={<Percent size={12} />}
              value={opacityValue}
              onCommit={(n) =>
                (kind === 'image'
                  ? commitImage({ opacity: Math.min(1, Math.max(0.01, n / 100)) })
                  : commitText({ opacity: Math.min(1, Math.max(0.01, n / 100)) }))
              }
              min={1}
              max={100}
              stepAmount={5}
              width="w-24"
              suffix="%"
            />
            {kind === 'image' && (
              <RibbonIconInput
                label="Scale"
                ariaLabel="Watermark scale"
                icon={<Scaling size={12} />}
                value={scaleValue}
                onCommit={(n) => commitImage({ scale: Math.max(0.05, n / 100) })}
                min={5}
                max={100}
                stepAmount={10}
                width="w-24"
                suffix="%"
              />
            )}
          </div>
        </Tabs>
      </div>
    </div>
  );
}
