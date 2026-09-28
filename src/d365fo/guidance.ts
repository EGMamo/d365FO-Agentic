import type { AppConfig } from '../config/index.js';

/**
 * D365 F&O–specific guidance surfaced to the agent as part of its system
 * prompt. Includes the login flow, company selection idiom, and known-good
 * navigation patterns for the Unified Operations client.
 */
export function d365SystemGuidance(cfg: AppConfig): string {
  return [
    `Target environment: ${cfg.D365_BASE_URL ?? '(not configured)'}`,
    `Default legal entity / company: ${cfg.D365_COMPANY}`,
    '',
    'Login flow:',
    '1. Navigate to the D365 F&O URL.',
    '2. If redirected to login.microsoftonline.com, enter the username, click Next, enter the password, and click Sign in.',
    '3. If prompted to stay signed in, click "No".',
    '4. Wait for the F&O client dashboard (accessibility landmark: "navigation" with app name) to be visible.',
    '',
    'Company (legal entity) selection:',
    '- The current company appears in the top navigation bar as a code (e.g. USMF).',
    '- To change it, click the company code, then pick from the list or type to filter.',
    '',
    'Navigation patterns:',
    '- Use the navigation pane (hamburger icon) to open Modules → <Module> → <Menu item>.',
    '- Prefer the top search box ("Ctrl+/" or the magnifier icon) with a menu-item label for deterministic navigation.',
    '- Detail forms follow a header/lines pattern; use tab captions (General, Setup, etc.) to reveal fields.',
    '- Grid rows are keyboard-focusable; use ArrowDown / Tab to move; avoid brittle x/y clicks.',
    '',
    'Safety rules:',
    '- Only perform destructive actions (post, confirm, delete) inside the configured legal entity.',
    '- Never change tenant-wide or environment-wide settings.',
    '- If a step requires elevated privileges or would affect production, mark it BLOCKED and stop.',
  ].join('\n');
}
