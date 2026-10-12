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
    required: ['field'],
    properties: {
      field: { type: 'string', enum: ['username', 'password'] },
      ref: { type: 'string', description: 'Element ref from the latest browser_snapshot (e.g. "e28")' },
      target: { type: 'string', description: 'Alias of `ref`' },
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

const SECRET_KEYS = [
  'D365_PASSWORD',
  'D365_USERNAME',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_COMPATIBLE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'GITHUB_COPILOT_TOKEN',
  'AZDO_PAT',
  'D365_CLIENT_SECRET',
] as const;

// Token shapes that can show up in page text or errors even when they are not configured values.
const TOKEN_PATTERNS = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
];

/** Replaces any configured secret, and anything shaped like an access token, in `text` with `***`. */
export function redactSecrets(cfg: Partial<Record<(typeof SECRET_KEYS)[number], string | undefined>>, text: string): string {
  let out = text;
  for (const key of SECRET_KEYS) {
    const secret = cfg[key];
    if (secret) out = out.split(secret).join('***');
  }
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '***');
  return out;
}

/**
 * Builds the `browser_type` arguments for the installed Playwright MCP. Newer
 * releases take the snapshot reference as `target`; older ones as `ref`. The
 * server's input schema is strict, so only the key it declares may be sent.
 */
export function browserTypeArgs(
  schema: Record<string, unknown> | undefined,
  a: { ref: string; element?: string; text: string; submit?: boolean },
): Record<string, unknown> {
  const props = (schema?.properties ?? {}) as Record<string, unknown>;
  const refKey = 'target' in props || !('ref' in props) ? 'target' : 'ref';
  const args: Record<string, unknown> = { [refKey]: a.ref, text: a.text, submit: Boolean(a.submit) };
  if (a.element && (!schema || 'element' in props)) args.element = a.element;
  return args;
}

/** Flattens an MCP error result into short text, with credentials redacted by the caller. */
export function mcpErrorText(content: unknown): string {
  if (Array.isArray(content)) {
    const t = content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n');
    if (t) return t;
  }
  return typeof content === 'string' ? content : JSON.stringify(content);
}
