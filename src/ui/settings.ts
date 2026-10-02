export interface SettingField {
  key: string;
  label: string;
  group: string;
  /** Never sent to the browser; the UI only learns whether it is set. */
  secret?: boolean;
  options?: string[];
  placeholder?: string;
  help?: string;
}

const bool = ['true', 'false'];

export const SETTING_FIELDS: SettingField[] = [
  { group: 'LLM', key: 'LLM_PROVIDER', label: 'Provider', options: ['anthropic', 'openai', 'azure-openai', 'github-models', 'github-copilot', 'openai-compatible'] },
  { group: 'LLM', key: 'GITHUB_COPILOT_MODEL', label: 'GitHub Copilot model', placeholder: 'gpt-4.1', help: 'Used when provider = github-copilot' },
  { group: 'LLM', key: 'GITHUB_COPILOT_TOKEN', label: 'GitHub Copilot token', secret: true, help: 'Optional: `copilot-login` saves one for you' },
  { group: 'LLM', key: 'LLM_MODEL', label: 'Anthropic model', placeholder: 'claude-opus-4-5-20251101', help: 'Used when provider = anthropic' },
  { group: 'LLM', key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true },
  { group: 'LLM', key: 'OPENAI_MODEL', label: 'OpenAI model', placeholder: 'gpt-4o' },
  { group: 'LLM', key: 'OPENAI_API_KEY', label: 'OpenAI API key', secret: true },
  { group: 'LLM', key: 'AZURE_OPENAI_ENDPOINT', label: 'Azure OpenAI endpoint' },
  { group: 'LLM', key: 'AZURE_OPENAI_DEPLOYMENT', label: 'Azure OpenAI deployment' },
  { group: 'LLM', key: 'AZURE_OPENAI_API_KEY', label: 'Azure OpenAI API key', secret: true },
  { group: 'LLM', key: 'GITHUB_MODELS_MODEL', label: 'GitHub Models model', placeholder: 'gpt-4o' },
  { group: 'LLM', key: 'GITHUB_TOKEN', label: 'GitHub Models token', secret: true },
  { group: 'LLM', key: 'OPENAI_COMPATIBLE_BASE_URL', label: 'Local/compatible base URL', placeholder: 'http://localhost:11434/v1' },
  { group: 'LLM', key: 'OPENAI_COMPATIBLE_MODEL', label: 'Local/compatible model', help: 'e.g. a name from `ollama list`' },
  { group: 'LLM', key: 'OPENAI_COMPATIBLE_API_KEY', label: 'Local/compatible API key', secret: true },
  { group: 'LLM', key: 'LLM_MAX_TOKENS', label: 'Max output tokens', placeholder: '4096' },
  { group: 'LLM', key: 'LLM_TEMPERATURE', label: 'Temperature', placeholder: '0.1' },

  { group: 'Dynamics 365 F&O', key: 'D365_BASE_URL', label: 'Base URL', placeholder: 'https://your-env.sandbox.operations.dynamics.com' },
  { group: 'Dynamics 365 F&O', key: 'D365_ENVIRONMENT_TYPE', label: 'Environment type', options: ['', 'sandbox', 'dev', 'production'], help: 'Empty = guess from the URL' },
  { group: 'Dynamics 365 F&O', key: 'D365_COMPANY', label: 'Company (legal entity)', placeholder: 'USMF' },
  { group: 'Dynamics 365 F&O', key: 'D365_TENANT_ID', label: 'Tenant ID' },
  { group: 'Dynamics 365 F&O', key: 'D365_USERNAME', label: 'Username' },
  { group: 'Dynamics 365 F&O', key: 'D365_PASSWORD', label: 'Password', secret: true },
  { group: 'Dynamics 365 F&O', key: 'D365_STORAGE_STATE', label: 'Saved session file', help: 'Created by `session-login`; empty = password login' },

  { group: 'Azure DevOps', key: 'AZDO_ORG_URL', label: 'Organization URL', placeholder: 'https://dev.azure.com/your-org' },
  { group: 'Azure DevOps', key: 'AZDO_PROJECT', label: 'Project' },
  { group: 'Azure DevOps', key: 'AZDO_PAT', label: 'Personal access token', secret: true },
  { group: 'Azure DevOps', key: 'AZDO_TEST_PLAN_ID', label: 'Default test plan ID' },
  { group: 'Azure DevOps', key: 'AZDO_TEST_SUITE_ID', label: 'Default test suite ID' },

  { group: 'Agent & browser', key: 'PW_HEADLESS', label: 'Headless browser', options: bool, help: 'false = watch the browser' },
  { group: 'Agent & browser', key: 'PW_BROWSER', label: 'Browser', options: ['chromium', 'firefox', 'webkit'] },
  { group: 'Agent & browser', key: 'PW_TRACE', label: 'Playwright trace', options: ['on-failure', 'on', 'off'] },
  { group: 'Agent & browser', key: 'AGENT_VERBOSE', label: 'Verbose log', options: bool },
  { group: 'Agent & browser', key: 'AGENT_MAX_STEPS', label: 'Max steps per case', placeholder: '40' },
  { group: 'Agent & browser', key: 'AGENT_RELOOP_MAX_RETRIES', label: 'Retries per case', placeholder: '1' },
  { group: 'Agent & browser', key: 'AGENT_ALLOWED_HOSTS', label: 'Extra allowed hosts', help: 'Comma-separated, e.g. an ADFS server' },
  { group: 'Agent & browser', key: 'AGENT_ALLOW_PRODUCTION', label: 'Allow production', options: bool },
  { group: 'Agent & browser', key: 'REPORT_DIR', label: 'Report directory', placeholder: './reports' },
];

export const SETTING_KEYS = new Set(SETTING_FIELDS.map((f) => f.key));
