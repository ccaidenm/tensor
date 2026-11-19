/** @browsermt/bergamot-translator — the Bergamot WASM engine's JS
 *  wrapper (BatchTranslator). No upstream types; the README contract,
 *  minimally typed for the translate/local engine. */
declare module '@browsermt/bergamot-translator/translator.js' {
  export interface TranslatorOptions {
    pivotLanguage?: string | null;
    registryUrl?: string;
    workerUrl?: string;
    downloadTimeout?: number;
    cacheSize?: number;
    useNativeIntGemm?: boolean;
    workers?: number;
    batchSize?: number;
  }

  export interface TranslationRequest {
    from: string;
    to: string;
    text: string;
    html?: boolean;
    qualityScores?: boolean;
    priority?: number;
  }

  export interface TranslationResponse {
    request: TranslationRequest;
    target: { text: string };
  }

  export class BatchTranslator {
    constructor(options?: TranslatorOptions);
    translate(request: TranslationRequest): Promise<TranslationResponse>;
    delete(): void;
  }
}
