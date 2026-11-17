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
  'AI model': 'One Claude connection for chat and all test runs.',
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
  { group: 'AI model', key: 'ANTHROPIC_API_KEY', label: 'Claude API key', secret: true },
  { group: 'AI model', key: 'LLM_MODEL', label: 'Model name', advanced: true, placeholder: 'claude-opus-4-5-20251101' },
  {
    group: 'AI model',
    key: 'ANTHROPIC_BASE_URL',
    label: 'API URL',
    type: 'url',
    advanced: true,
    placeholder: 'https://api.anthropic.com',
    help: 'Leave empty for Anthropic. For a company gateway, paste the address it gives you.',
  },
  {
    group: 'AI model',
    key: 'LLM_API_FORMAT',
    label: 'API format',
    options: ['', 'openai'],
    advanced: true,
    help: 'Use OpenAI-compatible for gateways that serve /v1/chat/completions (for example LiteLLM-based corporate GenAI services). The model name is the one the gateway lists.',
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
