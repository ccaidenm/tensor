import { useEffect, useRef } from 'react';
import { useConfigStore } from '../config/store';
import { useDocumentStore } from './store';
import { saveDocument } from './fileOperations';
import { clearRecoveryCopy, saveRecoveryCopy } from './recovery';

export function useAutosave() {
  const revision = useDocumentStore((s) => s.revision);
  const isDirty = useDocumentStore((s) => s.isDirty);
  const intervalMs = useConfigStore((s) => s.config.autosaveIntervalMs);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isDirty) return;

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const { editor, filePath, pageSetup, lineNumbers, coreProperties, headerFooter } =
        useDocumentStore.getState();
      if (!editor) return;

      await saveRecoveryCopy(editor, filePath, {
        pageSetup,
        lineNumbers,
        coreProperties,
        headerFooter,
      });

      // M-DOCX: the timed write is WPDOC-ONLY. A .docx document's file
      // may be open in real Word (file locks) and every Save is a full
      // export — churn to avoid. Word-backed documents rely on the
      // recovery snapshots (above) between explicit Saves; .wpdoc
      // documents keep the transparent timed save.
      if (filePath && filePath.toLowerCase().endsWith('.wpdoc')) {
        await saveDocument(editor, filePath, { pageSetup, lineNumbers, coreProperties, headerFooter });
        await clearRecoveryCopy(filePath);
        useDocumentStore.setState({ isDirty: false });
      }
    }, intervalMs);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [revision, intervalMs, isDirty]);
}
