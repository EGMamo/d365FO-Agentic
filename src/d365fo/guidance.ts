import type { AppConfig } from '../config/index.js';
import { activeSessionFile } from './session.js';

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
    ...(activeSessionFile(cfg)
      ? [
          'A saved, already signed-in browser session is loaded. Navigate to the D365 F&O URL; you should land on the F&O client without signing in.',
          cfg.D365_USERNAME && cfg.D365_PASSWORD
            ? 'If you are redirected to login.microsoftonline.com anyway (the session expired), fall back to the credential steps below.'
            : 'If you are redirected to login.microsoftonline.com (the session expired), mark the step BLOCKED and say the saved session must be renewed with `session-login`; no credentials are configured.',
          'Never sign out, log off or end the session (user menu, /Logout, End sessions): the saved session is reused by later runs and signing out would invalidate it.',
        ]
      : []),
    '1. Navigate to the D365 F&O URL.',
    '2. If redirected to login.microsoftonline.com, take a `browser_snapshot`, then call `d365_enter_credential` with field="username" and the ref of the email field (submit=true), snapshot again, and call it with field="password" and the password field ref (submit=true).',
    '   You never see the credentials and must NOT type them yourself with `browser_type`; only `d365_enter_credential` has them. Only if it says no value is configured for the field, mark the step BLOCKED; if it reports that typing failed, read the error, take a fresh snapshot and retry.',
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
