import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { credentialEntryCode } from './login.js';

const secret = 'fake-password-for-isolated-tests';
function fixture(over: { origin?: string; name?: string; type?: string; action?: string; hidden?: boolean; nested?: boolean; duplicate?: boolean; redirectOnInput?: boolean } = {}) {
  const location = { href: `${over.origin ?? 'https://login.microsoftonline.com'}/tenant/login`, origin: over.origin ?? 'https://login.microsoftonline.com' };
  const events: string[] = [];
  let submitted = false;
  const form = { method: 'post', action: over.action ?? `${location.origin}/tenant/login`, requestSubmit() { submitted = true; } };
  class Input {
    name = over.name ?? 'passwd'; type = over.type ?? 'password'; id = 'i0118';
    disabled = false; readOnly = false; isConnected = true; form = form; private stored = '';
    get value(): string { return this.stored; }
    set value(value: string) { this.stored = value; }
    getClientRects() { return over.hidden ? [] : [{}]; }
    dispatchEvent(event: { type: string }) {
      events.push(event.type);
      if (over.redirectOnInput && event.type === 'input') { location.origin = 'https://attacker.example'; form.action = 'https://attacker.example/collect'; }
      return true;
    }
  }
  const control = new Input();
  const window: { top?: unknown } = {};
  window.top = over.nested ? {} : window;
  const context = {
    URL, location, window, HTMLInputElement: Input,
    Event: class { constructor(readonly type: string) {} },
    document: { querySelectorAll: () => over.duplicate ? [control, control] : [control] },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  };
  return {
    control, events, submitted: () => submitted,
    execute: (submit = true) => runInNewContext(`(${credentialEntryCode('password', secret, submit)})`, context)({ evaluate: (fn: (input: unknown) => unknown, input: unknown) => fn(input) }),
  };
}

describe('atomic credential entry', () => {
  it('fills only the real visible Microsoft password control and submits the same-origin form', async () => {
    const page = fixture();
    const result = await page.execute();
    assert.equal(page.control.value, secret);
    assert.deepEqual(page.events, ['input', 'change']);
    assert.equal(page.submitted(), true);
    assert.equal(JSON.stringify(result), '{"ok":true,"entered":"password"}');
    assert.ok(!JSON.stringify(result).includes(secret));
  });

  for (const [name, over] of Object.entries({
    'redirected attacker page': { origin: 'https://attacker.example' },
    'lookalike Microsoft host': { origin: 'https://login.microsoftonline.com.attacker.example' },
    'insecure Microsoft page': { origin: 'http://login.microsoftonline.com' },
    'business input with password description': { name: 'SearchText' },
    'wrong control type': { type: 'text' },
    'external form action': { action: 'https://attacker.example/collect' },
    'hidden control': { hidden: true },
    'nested frame': { nested: true },
    'ambiguous controls': { duplicate: true },
  })) {
    it(`refuses ${name} before filling any credential`, async () => {
      const page = fixture(over);
      await assert.rejects(page.execute(), /Credential entry refused/);
      assert.equal(page.control.value, '');
      assert.equal(page.submitted(), false);
    });
  }

  it('does not submit if the page or form changes during input events', async () => {
    const page = fixture({ redirectOnInput: true });
    await assert.rejects(page.execute(), /Credential entry refused/);
    assert.equal(page.submitted(), false);
  });
});
