import { useConfigStore } from '@/lib/config/store';
import { useDocumentStore } from '@/lib/document/store';
import { resolveViewMode } from '@/lib/document/pageSetup';

/**
 * The one React read of the resolved rendering mode — every consumer
 * routes through here (the document's choice, else the app default).
 */
export function useViewMode(): 'Pages' | 'Pageless' {
  const docMode = useDocumentStore((s) => s.pageSetup.viewMode);
  const configDefault = useConfigStore((s) => s.config.editor.defaultPageLayout);
  return resolveViewMode(docMode, configDefault);
}
