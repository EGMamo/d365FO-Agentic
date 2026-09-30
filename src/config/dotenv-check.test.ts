import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'dotenv';
import { dotenvProblems } from './dotenv-check.js';

describe('dotenvProblems', () => {
  it('flags an unquoted password whose "#" would truncate it, without echoing the value', () => {
    const [p] = dotenvProblems('LLM_PROVIDER=x\nD365_PASSWORD=Ab12#@!z\n');
    assert.equal(p.line, 2);
    assert.equal(p.key, 'D365_PASSWORD');
    assert.equal(p.secret, true);
    assert.match(p.message, /only 4 character\(s\) are read.*D365_PASSWORD='\.\.\.'/);
    assert.ok(!p.message.includes('@!z') && !p.message.includes('Ab12'));
  });

  it('agrees with what dotenv really does, and quoting really fixes it', () => {
    assert.equal(parse('D365_PASSWORD=Ab12#@!z').D365_PASSWORD, 'Ab12');
    assert.equal(parse("D365_PASSWORD='Ab12#@!z'").D365_PASSWORD, 'Ab12#@!z');
    assert.equal(parse('D365_PASSWORD="Ab12#@!z"').D365_PASSWORD, 'Ab12#@!z');
    assert.equal(parse('D365_PASSWORD=`Ab12#@!z`').D365_PASSWORD, 'Ab12#@!z');
  });

  it('leaves quoted values, real inline comments and comment lines alone', () => {
    const ok = [
      "D365_PASSWORD='Ab12#@!z'", 'D365_PASSWORD="Ab12#@!z"', 'D365_PASSWORD=`Ab12#@!z`',
      'AZDO_TEST_PLAN_ID=1234  # the plan', 'LLM_PROVIDER=github-copilot # for now', '# D365_PASSWORD=Ab12#@!z', '   # indented comment=a#b',
      'EMPTY=', 'PLAIN=value', 'KEY=#starts-with-hash',
    ].join('\n');
    assert.deepEqual(dotenvProblems(ok), []);
  });

  it('reports non-credential variables too, but marks them as not secret', () => {
    const [p] = dotenvProblems('export AZDO_PROJECT=My#Project');
    assert.equal(p.key, 'AZDO_PROJECT');
    assert.equal(p.secret, false);
  });

  it('classifies credential-like names as secret', () => {
    const names = ['D365_PASSWORD', 'AZDO_PAT', 'ANTHROPIC_API_KEY', 'GITHUB_COPILOT_TOKEN', 'OPENAI_COMPATIBLE_API_KEY', 'MY_SECRET'];
    for (const n of names) assert.equal(dotenvProblems(`${n}=a#b`)[0].secret, true, n);
    assert.equal(dotenvProblems('D365_COMPANY=a#b')[0].secret, false);
  });

  it('handles Windows line endings and reports every offending line', () => {
    const found = dotenvProblems('A_PASSWORD=x#1\r\nB=fine\r\nC_TOKEN=y#2\r\n');
    assert.deepEqual(found.map((p) => [p.line, p.key]), [[1, 'A_PASSWORD'], [3, 'C_TOKEN']]);
  });
});
