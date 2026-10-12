/** The settings the UI knows how to present as a form. Anything else a profile holds is shown as a custom variable. */
export interface FieldSpec {
  key: string;
  label: string;
  group: string;
  help?: string;
  options?: string[];
  secret?: boolean;
  placeholder?: string;
  /** Shown only while `LLM_PROVIDER` is one of these (the empty provider counts as `anthropic`). */
  providers?: string[];
  /** Tucked under "More settings" in its group: most people never change it. */
  advanced?: boolean;
  /** Needed before a run can start; the form marks it and the setup checklist counts it. */
  required?: boolean;
  /** `url` values are checked for an http(s) address, `number` for a whole number, before saving. */
  type?: 'url' | 'number';
}

/** One line under each group heading, saying what the group is for in plain words. */
export const GROUP_INFO: Record<string, string> = {
  'Dynamics 365 F&O': 'The environment to test and how the agent signs in to it.',
  'AI model': 'The model that reads each test case and drives the browser.',
  'Azure DevOps': 'Optional. Read test cases from a Test Plan and publish results back.',
  Browser: 'How the test browser runs.',
  'Safety limits': 'Limits that stop a test that is stuck or going where it should not.',
};

/** Display names for the `LLM_PROVIDER` values. */
export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'OpenAI',
  'azure-openai': 'Azure OpenAI',
  'github-copilot': 'GitHub Copilot',
  'github-models': 'GitHub Models',
  'openai-compatible': 'Local or OpenAI-compatible (Ollama, LM Studio…)',
};

const bool = ['true', 'false'];

export const FIELD_CATALOG: FieldSpec[] = [
  { group: 'Dynamics 365 F&O', key: 'D365_BASE_URL', label: 'F&O address', type: 'url', required: true, placeholder: 'https://contoso.sandbox.operations.dynamics.com', help: 'The web address you open F&O with. Use a sandbox, not production.' },
  { group: 'Dynamics 365 F&O', key: 'D365_USERNAME', label: 'Username', placeholder: 'tester@contoso.com', help: 'A test account. One without MFA is simplest; for MFA use a saved session below.' },
  { group: 'Dynamics 365 F&O', key: 'D365_PASSWORD', label: 'Password', secret: true },
  { group: 'Dynamics 365 F&O', key: 'D365_COMPANY', label: 'Legal entity', placeholder: 'USMF', help: 'The company the tests run in.' },
  { group: 'Dynamics 365 F&O', key: 'D365_ENVIRONMENT_TYPE', label: 'Environment type', options: ['', 'sandbox', 'dev', 'production'], help: 'Leave on "guess from the address" unless the check says the type is unknown. Production runs are refused unless you allow them under Safety limits.' },
  { group: 'Dynamics 365 F&O', key: 'D365_STORAGE_STATE', label: 'Saved session file', advanced: true, help: 'For accounts with MFA: the file written by `d365fo-agent session-login`. Replaces the password.' },
  { group: 'Dynamics 365 F&O', key: 'D365_TENANT_ID', label: 'Entra tenant ID', advanced: true, help: 'Optional app registration, so the agent can check data through OData. Register the client ID in F&O under Microsoft Entra ID applications.' },
  { group: 'Dynamics 365 F&O', key: 'D365_CLIENT_ID', label: 'App (client) ID', advanced: true },
  { group: 'Dynamics 365 F&O', key: 'D365_CLIENT_SECRET', label: 'Client secret', secret: true, advanced: true },

  { group: 'AI model', key: 'LLM_PROVIDER', label: 'Provider', options: ['anthropic', 'openai', 'azure-openai', 'github-copilot', 'github-models', 'openai-compatible'] },
  { group: 'AI model', key: 'ANTHROPIC_API_KEY', label: 'Claude API key', secret: true, required: true, providers: ['anthropic'], placeholder: 'sk-ant-…', help: 'From console.anthropic.com, or the key your gateway gave you.' },
  { group: 'AI model', key: 'ANTHROPIC_BASE_URL', label: 'Claude API URL', type: 'url', providers: ['anthropic'], placeholder: 'https://api.anthropic.com (default)', help: 'Leave empty to use Anthropic directly. To go through your own gateway or proxy, enter its address, for example https://llm-gateway.contoso.com/anthropic.' },
  { group: 'AI model', key: 'LLM_MODEL', label: 'Claude model', providers: ['anthropic'], placeholder: 'claude-opus-4-5-20251101', help: 'Leave empty for the default. With a custom URL, use the model name your gateway expects.' },
  { group: 'AI model', key: 'ANTHROPIC_AUTH_TOKEN', label: 'Gateway bearer token', secret: true, advanced: true, providers: ['anthropic'], help: 'Only for a custom URL whose gateway expects "Authorization: Bearer" in place of, or as well as, an API key.' },
  { group: 'AI model', key: 'OPENAI_API_KEY', label: 'OpenAI API key', secret: true, required: true, providers: ['openai'] },
  { group: 'AI model', key: 'OPENAI_MODEL', label: 'OpenAI model', placeholder: 'gpt-4o', providers: ['openai'] },
  { group: 'AI model', key: 'AZURE_OPENAI_ENDPOINT', label: 'Azure OpenAI endpoint', type: 'url', required: true, providers: ['azure-openai'], placeholder: 'https://contoso.openai.azure.com' },
  { group: 'AI model', key: 'AZURE_OPENAI_API_KEY', label: 'Azure OpenAI key', secret: true, required: true, providers: ['azure-openai'] },
  { group: 'AI model', key: 'AZURE_OPENAI_DEPLOYMENT', label: 'Azure OpenAI deployment', required: true, providers: ['azure-openai'] },
  { group: 'AI model', key: 'GITHUB_COPILOT_TOKEN', label: 'GitHub Copilot token', secret: true, providers: ['github-copilot'], help: 'Or sign in once with `d365fo-agent copilot-login` and leave this empty.' },
  { group: 'AI model', key: 'GITHUB_COPILOT_MODEL', label: 'Copilot model', placeholder: 'gpt-4.1', providers: ['github-copilot'] },
  { group: 'AI model', key: 'GITHUB_TOKEN', label: 'GitHub Models token', secret: true, required: true, providers: ['github-models'] },
  { group: 'AI model', key: 'GITHUB_MODELS_MODEL', label: 'GitHub Models model', placeholder: 'gpt-4o', providers: ['github-models'] },
  { group: 'AI model', key: 'OPENAI_COMPATIBLE_BASE_URL', label: 'Model server URL', type: 'url', providers: ['openai-compatible'], placeholder: 'http://localhost:11434/v1', help: 'Ollama, LM Studio, llama.cpp, vLLM or any OpenAI-style server.' },
  { group: 'AI model', key: 'OPENAI_COMPATIBLE_MODEL', label: 'Model name', required: true, providers: ['openai-compatible'], help: 'The name the server lists, e.g. from `ollama list`.' },
  { group: 'AI model', key: 'OPENAI_COMPATIBLE_API_KEY', label: 'Model server key', secret: true, advanced: true, providers: ['openai-compatible'], help: 'Only when the server asks for one.' },

  { group: 'Azure DevOps', key: 'AZDO_ORG_URL', label: 'Organization URL', type: 'url', placeholder: 'https://dev.azure.com/contoso' },
  { group: 'Azure DevOps', key: 'AZDO_PROJECT', label: 'Project' },
  { group: 'Azure DevOps', key: 'AZDO_PAT', label: 'Personal access token', secret: true, help: 'Needs Test Management read and write.' },
  { group: 'Azure DevOps', key: 'AZDO_TEST_PLAN_ID', label: 'Test plan ID', type: 'number' },
  { group: 'Azure DevOps', key: 'AZDO_TEST_SUITE_ID', label: 'Test suite ID', type: 'number' },

  { group: 'Browser', key: 'PW_HEADLESS', label: 'Hide the browser window', options: bool, help: 'Choose false to watch the browser while a test runs.' },
  { group: 'Browser', key: 'PW_BROWSER', label: 'Browser', options: ['chromium', 'firefox', 'webkit'], advanced: true },

  { group: 'Safety limits', key: 'AGENT_DRY_RUN', label: 'Dry run (no clicks or typing)', options: bool },
  { group: 'Safety limits', key: 'AGENT_RELOOP_MAX_RETRIES', label: 'Retries after a failed attempt', type: 'number', placeholder: '1' },
  { group: 'Safety limits', key: 'AGENT_ALLOW_DESTRUCTIVE', label: 'Allow delete/remove clicks', options: bool },
  { group: 'Safety limits', key: 'AGENT_ALLOW_PRODUCTION', label: 'Allow production runs', options: bool, help: 'Leave on false. Tests create and change data.' },
  { group: 'Safety limits', key: 'AGENT_STOP_ON_AUTH_FAILURE', label: 'Stop on MFA or refused sign-in', options: bool, advanced: true },
  { group: 'Safety limits', key: 'AGENT_MAX_STEPS', label: 'Max model turns per test', type: 'number', placeholder: '40', advanced: true },
  { group: 'Safety limits', key: 'AGENT_TEST_TIMEOUT_MS', label: 'Max time per test (ms)', type: 'number', placeholder: '900000', help: '0 turns the limit off.', advanced: true },
  { group: 'Safety limits', key: 'AGENT_MAX_TOKENS_PER_TEST', label: 'Max tokens per test', type: 'number', placeholder: '1000000', help: '0 turns the limit off.', advanced: true },
  { group: 'Safety limits', key: 'AGENT_MAX_REPEATED_CALLS', label: 'Max identical calls in a row', type: 'number', placeholder: '3', advanced: true },
  { group: 'Safety limits', key: 'AGENT_MAX_CONSECUTIVE_ERRORS', label: 'Max failing calls in a row', type: 'number', placeholder: '5', advanced: true },
  { group: 'Safety limits', key: 'AGENT_MAX_UNREACHABLE_TARGETS', label: 'Max missing pages before stopping', type: 'number', placeholder: '3', advanced: true },
];
