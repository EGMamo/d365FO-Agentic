export interface FieldSpec {
  key: string;
  label: string;
  group: string;
  help?: string;
  options?: string[];
  secret?: boolean;
  placeholder?: string;
  advanced?: boolean;
  type?: 'url' | 'number';
}
export const GROUP_INFO: Record<string, string> = {
  'Dynamics 365 F&O': 'Choose the sandbox and how to sign in.',
  'AI model': 'One model connection for chat and all test runs: Claude, a local server, or an OpenAI-compatible gateway.',
  'Azure DevOps': 'Optional: read test plans and upload results.',
};
export const PROVIDER_LABELS = { anthropic: 'Claude (Anthropic)' };
export const FIELD_CATALOG: FieldSpec[] = [
  {
    group: 'Dynamics 365 F&O',
    key: 'D365_BASE_URL',
    label: 'F&O address',
    type: 'url',
    placeholder: 'https://contoso.sandbox.operations.dynamics.com',
  },
  { group: 'Dynamics 365 F&O', key: 'D365_USERNAME', label: 'Username' },
  { group: 'Dynamics 365 F&O', key: 'D365_PASSWORD', label: 'Password', secret: true },
  {
    group: 'Dynamics 365 F&O',
    key: 'D365_STORAGE_STATE',
    label: 'Saved session file',
    help: 'For MFA, use the session saved by session-login. Replaces password sign-in.',
  },
  { group: 'Dynamics 365 F&O', key: 'D365_COMPANY', label: 'Legal entity', placeholder: 'USMF' },
  {
    group: 'Dynamics 365 F&O',
    key: 'D365_ENVIRONMENT_TYPE',
    label: 'Environment type',
    options: ['', 'sandbox', 'dev', 'production'],
    advanced: true,
    help: 'Production protection remains enabled.',
  },
  {
    group: 'Dynamics 365 F&O',
    key: 'D365_ODATA_AUTH',
    label: 'Data access sign-in',
    options: ['', 'browser', 'password', 'azure-cli'],
    advanced: true,
    help: 'How the agent reads F&O data (OData, read only). Empty follows how the tests sign in: browser (sign in once with "Sign in for data access"), password (no MFA) or the Azure CLI account.',
  },
  {
    group: 'Dynamics 365 F&O',
    key: 'AGENT_PREFLIGHT',
    label: 'Unfilled TBC values',
    options: ['', 'block', 'partial', 'off'],
    advanced: true,
    help: 'What to do with a case whose steps still have TBC placeholders or @parameters with no value. block (default): end it as blocked before it runs, listing what is missing. partial: run only the steps that do not need them. off: ignore them, run the whole case and let the agent decide.',
  },
  {
    group: 'Dynamics 365 F&O',
    key: 'AGENT_IGNORE_USER_ROLE',
    label: 'Cases that need a user role',
    options: ['', 'true', 'false'],
    advanced: true,
    help: 'true (default): run them as the signed-in user instead of blocking them, and note it in the result. false: block a case that names a role or another user to act as.',
  },
  {
    group: 'Dynamics 365 F&O',
    key: 'AGENT_FILL_FROM_ERP',
    label: 'Fill unset data from F&O',
    options: ['', 'true', 'false'],
    advanced: true,
    help: 'true (default): when a case leaves existing data unset (an active vendor, an item, a warehouse), the agent finds one in F&O (read only) and suggests saving it to the test case parameters. false: such cases are blocked as before. Needs data access (OData).',
  },
  {
    group: 'Dynamics 365 F&O',
    key: 'AGENT_RECORD_TESTS',
    label: 'Record standalone Playwright tests',
    options: ['', 'true', 'false'],
    advanced: true,
    help: 'true (default): save code emitted by successful allowlisted browser calls. Failed or incomplete recordings are fixme; interrupted and dry runs are not saved.',
  },
  {
    group: 'Dynamics 365 F&O',
    key: 'AGENT_REPLAY_DIR',
    label: 'Replay project folder',
    advanced: true,
    help: 'Optional. Defaults to <report folder>/replay for this profile. Existing generated config and helper edits are preserved.',
  },
  {
    group: 'AI model',
    key: 'LLM_API_FORMAT',
    label: 'Provider',
    options: ['', 'openai'],
    help: 'Claude uses the Anthropic Messages API. Local or OpenAI-compatible uses /v1/chat/completions: Ollama, LM Studio, LiteLLM or a company gateway.',
  },
  {
    group: 'AI model',
    key: 'ANTHROPIC_BASE_URL',
    label: 'API URL',
    type: 'url',
    placeholder: 'http://127.0.0.1:11434/v1',
    help: 'Leave empty for Anthropic. For a local server or company gateway, paste its address; model names are discovered from it.',
  },
  { group: 'AI model', key: 'LLM_MODEL', label: 'Model', placeholder: 'claude-opus-4-5-20251101' },
  {
    group: 'AI model',
    key: 'ANTHROPIC_API_KEY',
    label: 'API key or token',
    secret: true,
    help: 'The Claude key, or any value a local server accepts (for example local).',
  },
  { group: 'AI model', key: 'ANTHROPIC_AUTH_TOKEN', label: 'Gateway bearer token', secret: true, advanced: true },
  {
    group: 'Azure DevOps',
    key: 'AZDO_ORG_URL',
    label: 'Organization URL',
    type: 'url',
    placeholder: 'https://dev.azure.com/contoso',
  },
  { group: 'Azure DevOps', key: 'AZDO_PROJECT', label: 'Project' },
  {
    group: 'Azure DevOps',
    key: 'AZDO_PAT',
    label: 'Personal access token',
    secret: true,
    advanced: true,
    help: 'Optional alternative to Microsoft-account sign-in.',
  },
  {
    group: 'Azure DevOps',
    key: 'AZDO_AUTH',
    label: 'Sign-in method',
    options: ['', 'azure-cli', 'pat'],
    advanced: true,
  },
  { group: 'Azure DevOps', key: 'AZDO_TENANT_ID', label: 'Microsoft tenant', advanced: true },
];
