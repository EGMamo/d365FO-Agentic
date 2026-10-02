import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvText, quoteEnvValue, updateEnvText } from './env-file.js';

test('quoteEnvValue round-trips values dotenv would otherwise cut or mangle', () => {
  for (const v of ['M654#@!m', 'plain', '', 'has space', "it's", `a'b"c`, 'back\\slash\'q', ' lead', 'x=y', '"quoted"', 'https://h/x?a=1&b=2']) {
    const text = `K=${quoteEnvValue(v)}\n`;
    assert.equal(parseEnvText(text).K, v, `value ${JSON.stringify(v)} written as ${text.trim()}`);
  }
  assert.equal(quoteEnvValue('abc'), 'abc');
  assert.equal(quoteEnvValue('M654#@!m'), "'M654#@!m'");
  assert.throws(() => quoteEnvValue('a\nb'));
});

test('updateEnvText keeps comments and order, replaces in place and appends new keys', () => {
  const before = '# LLM\nLLM_PROVIDER=anthropic\n# pwd\nD365_PASSWORD=old\n\nREPORT_DIR=./reports\n';
  const after = updateEnvText(before, { LLM_PROVIDER: 'github-copilot', D365_PASSWORD: 'M654#@!m', D365_COMPANY: 'DAT', REPORT_DIR: null });
  assert.equal(after, "# LLM\nLLM_PROVIDER=github-copilot\n# pwd\nD365_PASSWORD='M654#@!m'\n\nREPORT_DIR=\nD365_COMPANY=DAT\n");
  assert.deepEqual(parseEnvText(after), { LLM_PROVIDER: 'github-copilot', D365_PASSWORD: 'M654#@!m', REPORT_DIR: '', D365_COMPANY: 'DAT' });
});

test('updateEnvText ignores commented-out keys and creates a file from nothing', () => {
  assert.equal(updateEnvText('# D365_COMPANY=USMF\n', { D365_COMPANY: 'DAT' }), '# D365_COMPANY=USMF\nD365_COMPANY=DAT\n');
  assert.equal(updateEnvText('', { A: '1' }), 'A=1\n');
});
