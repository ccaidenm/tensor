import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { resolveViewMode } from '@/lib/document/pageSetup';

/**
 * THE VIEW-MODE HOOK — the ONE React read of the resolved rendering
 * mode: the document's own choice (pageSetup.viewMode) when set, else
 * the app default (config.editor.defaultPageLayout — the
 * new-document default). Every consumer that used to read the loose
 * config string routes through here (the resolveViewMode law).
 */
export function useViewMode(): 'Pages' | 'Pageless' {
  const docMode = useDocumentStore((s) => s.pageSetup.viewMode);
  const configDefault = useConfigStore((s) => s.config.editor.defaultPageLayout);
  return resolveViewMode(docMode, configDefault);
}
