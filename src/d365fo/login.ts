import type { AppConfig } from '../config/index.js';
import type { LlmTool } from '../llm/types.js';

/**
 * The model never sees D365_USERNAME / D365_PASSWORD. It asks for them through
 * this local tool, and the orchestrator forwards the value straight to the
 * Playwright `browser_type` tool. Every tool result is scrubbed of the values
 * before it goes back into the conversation.
 */
export const CREDENTIAL_TOOL_NAME = 'd365_enter_credential';

export const CREDENTIAL_TOOL: LlmTool = {
  name: CREDENTIAL_TOOL_NAME,
  description:
    'Type the configured D365 test-account username or password into a login field. ' +
    'The secret is filled in for you and is never shown to you. Use `browser_snapshot` first to get the field `ref`. ' +
    'Set `submit` to press Enter after typing (use it for the username and the password steps of the Microsoft sign-in page).',
  inputSchema: {
    type: 'object',
    required: ['field', 'ref'],
    properties: {
      field: { type: 'string', enum: ['username', 'password'] },
      ref: { type: 'string', description: 'Element ref from the latest browser_snapshot' },
      element: { type: 'string', description: 'Human-readable field description (e.g. "Email or phone")' },
      submit: { type: 'boolean', description: 'Press Enter after typing', default: false },
    },
  },
};

export function credentialFor(cfg: AppConfig, field: unknown): string | undefined {
  if (field === 'username') return cfg.D365_USERNAME || undefined;
  if (field === 'password') return cfg.D365_PASSWORD || undefined;
  return undefined;
}

/** Replaces any occurrence of the configured credentials in `text` with `***`. */
export function redactSecrets(cfg: AppConfig, text: string): string {
  let out = text;
  for (const secret of [cfg.D365_PASSWORD, cfg.D365_USERNAME]) {
    if (secret) out = out.split(secret).join('***');
  }
  return out;
}
