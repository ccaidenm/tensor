import { useEffect, useRef } from 'react';
import { useConfigStore } from '../config/store';
import { useDocumentStore } from './store';
import { saveDocument } from './fileOperations';
import { clearRecoveryCopy, saveRecoveryCopy } from './recovery';
import { useCommentStore } from '@/lib/comments/store';

export function useAutosave() {
  const revision = useDocumentStore((s) => s.revision);
  const isDirty = useDocumentStore((s) => s.isDirty);
  const intervalMs = useConfigStore((s) => s.config.autosaveIntervalMs);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isDirty) return;

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const { editor, filePath, pageSetup, pageStyles, lineNumbers, coreProperties, headerFooter } =
        useDocumentStore.getState();
      if (!editor) return;

      await saveRecoveryCopy(editor, filePath, {
        pageSetup,
        pageStyles,
        lineNumbers,
        coreProperties,
        headerFooter,
        // Snapshots carry the threads — a restored doc must not lose comments.
        commentThreads: useCommentStore.getState().threadsForSave(),
      });

      // The timed write is .wpdoc-only: a .docx file may be open in real
      // Word (file locks) and every Save is a full export — Word-backed
      // docs rely on the recovery snapshots between explicit Saves.
      if (filePath && filePath.toLowerCase().endsWith('.wpdoc')) {
        await saveDocument(editor, filePath, {
          pageSetup,
          pageStyles,
          lineNumbers,
          coreProperties,
          headerFooter,
          commentThreads: useCommentStore.getState().threadsForSave(),
        });
        await clearRecoveryCopy(filePath);
        useDocumentStore.setState({ isDirty: false });
      }
    }, intervalMs);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [revision, intervalMs, isDirty]);
}
