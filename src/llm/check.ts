import type { AppConfig } from '../config/index.js';
import { createLlmProvider } from './index.js';
import type { LlmProvider } from './types.js';

export interface ModelCheck {
  ok: boolean;
  /** One plain sentence for the screen. */
  detail: string;
  at: string;
}

const TIMEOUT_MS = 25_000;

/** Asks the model for one word, to find out whether the key, address and model name work together. */
export async function checkModel(cfg: AppConfig, secrets: string[] = [], make: (cfg: AppConfig) => LlmProvider = createLlmProvider): Promise<ModelCheck> {
  const at = new Date().toISOString();
  const scrub = (text: string): string => secrets.reduce((t, s) => t.split(s).join('***'), text);
  let timer: NodeJS.Timeout | undefined;
  try {
    const provider = make(cfg);
    const answer = await Promise.race([
      provider.complete({ system: 'Answer with the single word OK.', messages: [{ role: 'user', content: 'Say OK.' }], maxTokens: 16 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`No answer within ${TIMEOUT_MS / 1000} seconds.`)), TIMEOUT_MS);
      }),
    ]);
    return { ok: true, detail: `The model answered${answer.text.trim() ? `: "${scrub(answer.text.trim()).slice(0, 40)}"` : ''}.`, at };
  } catch (e) {
    const message = scrub((e as Error).message.split('\n')[0]);
    if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.*(key|token)|incorrect api key/i.test(message)) {
      return { ok: false, detail: `The key was refused by this endpoint. Paste a new key and test again. (${message.slice(0, 160)})`, at };
    }
    if (/\b404\b|not found|does not exist|model.*not/i.test(message)) return { ok: false, detail: `The endpoint did not accept the model name or address. (${message.slice(0, 160)})`, at };
    return { ok: false, detail: message.slice(0, 240) || 'The model did not answer.', at };
  } finally {
    clearTimeout(timer);
  }
}
