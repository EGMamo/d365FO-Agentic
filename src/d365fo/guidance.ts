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
    ...(cfg.D365_TENANT_ID && cfg.D365_CLIENT_ID && cfg.D365_CLIENT_SECRET
      ? [
          '',
          'Data checks:',
          '- `d365_odata_query` reads F&O data entities with an app registration (read-only). Use it to confirm a record a step created or changed exists with the expected values, and quote the row in `observed`.',
          ...(!cfg.D365_USERNAME && !cfg.D365_PASSWORD && !activeSessionFile(cfg)
            ? ['- No user sign-in is configured, so the browser cannot open F&O. Do steps that are data checks with `d365_odata_query`; mark steps that need the F&O pages BLOCKED with cause "other" and say that no user sign-in is configured.']
            : []),
        ]
      : []),
    '',
    'Company (legal entity) selection:',
    '- The current company appears in the top navigation bar as a code (e.g. USMF).',
    '- To change it, click the company code, then pick from the list or type to filter.',
    '',
    'Navigation patterns:',
    '- To open a page, call `d365_open_menu_item` first: it loads the form directly by menu item in the right company and waits for it, in one call. A step like "Modules > Accounts payable > Vendors > All vendors" is satisfied by opening that page directly.',
    '- Only if it says the page is not known, use the top search box ("Alt+G" or the magnifier icon) with the page caption, then the navigation pane (Modules → <Module> → <Menu item>) as a last resort.',
    '- After a save, a lookup or a New/Edit click, wait for the "Please wait" overlay to clear before the next action.',
    '- Detail forms follow a header/lines pattern; use tab captions (General, Setup, etc.) to reveal fields.',
    '- Grid rows are keyboard-focusable; use ArrowDown / Tab to move; avoid brittle x/y clicks.',
    '',
    'Working fast on F&O forms:',
    "- Browser actions take `target`: a ref from the latest snapshot, or a Playwright locator. F&O control names (the AOT names Task Recorder records) are exposed as test ids, so `getByTestId('SystemDefinedNewButton')`, `getByTestId('SystemDefinedSaveButton')` or a field's control name work without a snapshot and do not change with language or release.",
    '- When you open a form you have worked on before, the result lists the controls learned there with their targets. Use them directly instead of taking a snapshot first. If one fails, take a snapshot and use a ref.',
    '- Full snapshots of F&O forms are large. To check one value or find one control, prefer `browser_find` (search the page for text) or `browser_snapshot` with a `target` (only that part of the page).',
    '- After a click, typing or a key press, the run already waits for the "Please wait" overlay to clear; do not add your own wait unless the page is still loading.',
    '- Type values into lookups and enum fields instead of picking a row from the drop-down list: list positions change when data changes (Microsoft RSAT guidance).',
    '- To find a record, filter the grid (the Filter field above it) instead of assuming the new or first row is the one you want.',
    '- When you learn something reusable about a form (a field hidden on a collapsed FastTab, a dialog that follows Save), save it with `d365_page_note` so the next run knows it.',
    '',
    'Waiting:',
    '- F&O forms load and refresh asynchronously. After every action that opens or saves a form, or runs a lookup, take a fresh `browser_snapshot` and confirm the page has settled (no busy or loading indicator, the expected control is present) before the next action.',
    '- If something is still loading, use `browser_wait_for` (a short time or the expected text) once and snapshot again; do not repeat the same action to force it.',
    '- A tool call that exceeds its time budget returns a timeout error: snapshot and check the page state before retrying, and mark the step BLOCKED if the page never settles.',
    '',
    'Safety rules:',
    '- Only perform destructive actions (post, confirm, delete) inside the configured legal entity.',
    '- Never change tenant-wide or environment-wide settings.',
    '- If a step requires elevated privileges or would affect production, mark it BLOCKED and stop.',
  ].join('\n');
}
