/** The settings the UI knows how to present as a form. Anything else a profile holds is shown as a custom variable. */
export interface FieldSpec {
  key: string;
  label: string;
  group: string;
  help?: string;
  options?: string[];
  secret?: boolean;
  placeholder?: string;
}

const bool = ['true', 'false'];

export const FIELD_CATALOG: FieldSpec[] = [
  { group: 'Dynamics 365 F&O', key: 'D365_BASE_URL', label: 'F&O URL', placeholder: 'https://contoso.sandbox.operations.dynamics.com', help: 'Base URL of the environment under test.' },
  { group: 'Dynamics 365 F&O', key: 'D365_USERNAME', label: 'Username' },
  { group: 'Dynamics 365 F&O', key: 'D365_PASSWORD', label: 'Password', secret: true },
  { group: 'Dynamics 365 F&O', key: 'D365_COMPANY', label: 'Legal entity', placeholder: 'USMF' },
  { group: 'Dynamics 365 F&O', key: 'D365_ENVIRONMENT_TYPE', label: 'Environment type', options: ['', 'sandbox', 'dev', 'production'], help: 'Leave empty to guess from the host. Production runs also need AGENT_ALLOW_PRODUCTION=true.' },
  { group: 'Dynamics 365 F&O', key: 'D365_STORAGE_STATE', label: 'Saved session file', help: 'Path written by `session-login`; use it for accounts with MFA.' },

  { group: 'AI model', key: 'LLM_PROVIDER', label: 'Provider', options: ['anthropic', 'openai', 'azure-openai', 'github-copilot', 'github-models', 'openai-compatible'] },
  { group: 'AI model', key: 'LLM_MODEL', label: 'Anthropic model' },
  { group: 'AI model', key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true },
  { group: 'AI model', key: 'OPENAI_API_KEY', label: 'OpenAI API key', secret: true },
  { group: 'AI model', key: 'OPENAI_MODEL', label: 'OpenAI model', placeholder: 'gpt-4o' },
  { group: 'AI model', key: 'AZURE_OPENAI_ENDPOINT', label: 'Azure OpenAI endpoint' },
  { group: 'AI model', key: 'AZURE_OPENAI_API_KEY', label: 'Azure OpenAI key', secret: true },
  { group: 'AI model', key: 'AZURE_OPENAI_DEPLOYMENT', label: 'Azure OpenAI deployment' },
  { group: 'AI model', key: 'GITHUB_COPILOT_TOKEN', label: 'GitHub Copilot token', secret: true, help: 'Or sign in once with `copilot-login`.' },
  { group: 'AI model', key: 'GITHUB_COPILOT_MODEL', label: 'Copilot model', placeholder: 'gpt-4.1' },
  { group: 'AI model', key: 'GITHUB_TOKEN', label: 'GitHub Models token', secret: true },
  { group: 'AI model', key: 'GITHUB_MODELS_MODEL', label: 'GitHub Models model', placeholder: 'gpt-4o' },
  { group: 'AI model', key: 'OPENAI_COMPATIBLE_BASE_URL', label: 'Local model URL', placeholder: 'http://localhost:11434/v1' },
  { group: 'AI model', key: 'OPENAI_COMPATIBLE_MODEL', label: 'Local model name' },

  { group: 'Azure DevOps', key: 'AZDO_ORG_URL', label: 'Organization URL', placeholder: 'https://dev.azure.com/contoso' },
  { group: 'Azure DevOps', key: 'AZDO_PROJECT', label: 'Project' },
  { group: 'Azure DevOps', key: 'AZDO_PAT', label: 'Personal access token', secret: true },
  { group: 'Azure DevOps', key: 'AZDO_TEST_PLAN_ID', label: 'Test plan ID' },
  { group: 'Azure DevOps', key: 'AZDO_TEST_SUITE_ID', label: 'Test suite ID' },

  { group: 'Browser', key: 'PW_HEADLESS', label: 'Headless', options: bool, help: 'Set false to watch the browser while it runs.' },
  { group: 'Browser', key: 'PW_BROWSER', label: 'Browser', options: ['chromium', 'firefox', 'webkit'] },

  { group: 'Safety limits', key: 'AGENT_MAX_STEPS', label: 'Max model turns per test', placeholder: '40' },
  { group: 'Safety limits', key: 'AGENT_TEST_TIMEOUT_MS', label: 'Max time per test (ms)', placeholder: '900000', help: '0 turns the limit off.' },
  { group: 'Safety limits', key: 'AGENT_MAX_TOKENS_PER_TEST', label: 'Max tokens per test', placeholder: '1000000', help: '0 turns the limit off.' },
  { group: 'Safety limits', key: 'AGENT_RELOOP_MAX_RETRIES', label: 'Retries after a failed attempt', placeholder: '1' },
  { group: 'Safety limits', key: 'AGENT_MAX_REPEATED_CALLS', label: 'Max identical calls in a row', placeholder: '3' },
  { group: 'Safety limits', key: 'AGENT_MAX_CONSECUTIVE_ERRORS', label: 'Max failing calls in a row', placeholder: '5' },
  { group: 'Safety limits', key: 'AGENT_MAX_UNREACHABLE_TARGETS', label: 'Max missing pages before stopping', placeholder: '3' },
  { group: 'Safety limits', key: 'AGENT_STOP_ON_AUTH_FAILURE', label: 'Stop on MFA or refused sign-in', options: bool },
  { group: 'Safety limits', key: 'AGENT_ALLOW_DESTRUCTIVE', label: 'Allow delete/remove clicks', options: bool },
  { group: 'Safety limits', key: 'AGENT_ALLOW_PRODUCTION', label: 'Allow production runs', options: bool },
  { group: 'Safety limits', key: 'AGENT_DRY_RUN', label: 'Dry run (no clicks or typing)', options: bool },
];
