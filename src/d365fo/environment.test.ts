import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowedHosts, assertSafeEnvironment, checkNavigation, classifyEnvironment, describeEnvironment, productionIssue } from './environment.js';

const BASE = 'https://contoso-uat.sandbox.operations.dynamics.com';
const cfg = { D365_BASE_URL: BASE, D365_COMPANY: 'USMF' };

describe('classifyEnvironment', () => {
  it('recognises sandbox, production, dev and unknown hosts', () => {
    assert.equal(classifyEnvironment('https://contoso-uat.sandbox.operations.dynamics.com/'), 'sandbox');
    assert.equal(classifyEnvironment('https://contoso.sandbox.operations.eu.dynamics.com'), 'sandbox');
    assert.equal(classifyEnvironment('https://contoso.operations.dynamics.com'), 'production');
    assert.equal(classifyEnvironment('https://contoso.operations.uae.dynamics.com/?cmp=usrt'), 'production');
    assert.equal(classifyEnvironment('https://dev123aos.axcloud.dynamics.com'), 'dev');
    assert.equal(classifyEnvironment('https://erp.contoso.com'), 'unknown');
    assert.equal(classifyEnvironment('http://localhost:5000'), 'unknown');
    assert.equal(classifyEnvironment(undefined), 'unknown');
    assert.equal(classifyEnvironment('not a url at all'), 'unknown');
  });

  it('does not mistake a sandbox-looking name for the sandbox label', () => {
    assert.equal(classifyEnvironment('https://sandbox-copy.operations.dynamics.com'), 'production');
  });
});

describe('production guard', () => {
  const prod = { D365_BASE_URL: 'https://contoso.operations.dynamics.com' };

  it('reports a production-looking host unless explicitly allowed', () => {
    assert.match(productionIssue(prod) ?? '', /looks like a PRODUCTION/);
    assert.throws(() => assertSafeEnvironment(prod), /PRODUCTION/);
    assert.equal(productionIssue({ ...prod, AGENT_ALLOW_PRODUCTION: true }), undefined);
    assert.equal(productionIssue(cfg), undefined);
    assert.doesNotThrow(() => assertSafeEnvironment(cfg));
  });

  it('points at D365_ENVIRONMENT_TYPE for unified sandboxes that share the production host format', () => {
    assert.match(productionIssue(prod) ?? '', /D365_ENVIRONMENT_TYPE=sandbox/);
  });

  it('lets a declared sandbox or dev type override the host guess', () => {
    assert.equal(classifyEnvironment(prod.D365_BASE_URL, 'sandbox'), 'sandbox');
    assert.equal(productionIssue({ ...prod, D365_ENVIRONMENT_TYPE: 'sandbox' }), undefined);
    assert.equal(productionIssue({ ...prod, D365_ENVIRONMENT_TYPE: 'dev' }), undefined);
  });

  it('still blocks a declared production environment, and the only way through is AGENT_ALLOW_PRODUCTION', () => {
    const declared = { D365_BASE_URL: BASE, D365_ENVIRONMENT_TYPE: 'production' as const };
    assert.match(productionIssue(declared) ?? '', /D365_ENVIRONMENT_TYPE is production/);
    assert.equal(productionIssue({ ...declared, AGENT_ALLOW_PRODUCTION: true }), undefined);
  });

  it('says whether the classification was declared or guessed', () => {
    assert.equal(describeEnvironment(prod), 'production, guessed from the URL');
    assert.equal(describeEnvironment({ ...prod, D365_ENVIRONMENT_TYPE: 'sandbox' }), 'sandbox, declared');
    assert.equal(describeEnvironment({ D365_BASE_URL: 'https://erp.contoso.com' }), 'unknown');
  });
});

describe('checkNavigation', () => {
  it('allows the F&O host and Microsoft sign-in pages', () => {
    assert.equal(checkNavigation(cfg, BASE), undefined);
    assert.equal(checkNavigation(cfg, `${BASE}/?mi=SalesTableListPage`), undefined);
    assert.equal(checkNavigation(cfg, 'https://login.microsoftonline.com/common/oauth2/authorize'), undefined);
    assert.equal(checkNavigation(cfg, 'https://contoso.b2clogin.microsoftonline.com/x'), undefined);
    assert.equal(checkNavigation(cfg, 'about:blank'), undefined);
    assert.equal(checkNavigation(cfg, 'contoso-uat.sandbox.operations.dynamics.com/'), undefined, 'bare host gets https://');
  });

  it('refuses other hosts, including lookalikes and userinfo tricks', () => {
    assert.match(checkNavigation(cfg, 'https://evil.example/steal') ?? '', /not allowed/);
    assert.match(checkNavigation(cfg, `${BASE}.evil.example/`) ?? '', /not allowed/);
    assert.match(checkNavigation(cfg, `https://${BASE.slice(8)}@evil.example/`) ?? '', /evil\.example/);
    assert.match(checkNavigation(cfg, 'https://login.microsoftonline.com.evil.example/') ?? '', /not allowed/);
    assert.match(checkNavigation(cfg, 'https://notmicrosoftonline.com/') ?? '', /not allowed/);
  });

  it('refuses non-http(s) schemes and unparseable input', () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings']) {
      assert.match(checkNavigation(cfg, u) ?? '', /not allowed/, u);
    }
    assert.match(checkNavigation(cfg, 'https://') ?? '', /not a valid URL/);
  });

  it('honours AGENT_ALLOWED_HOSTS, exact and wildcard', () => {
    const extra = { ...cfg, AGENT_ALLOWED_HOSTS: ['lcs.dynamics.com', '*.contoso.com'] };
    assert.equal(checkNavigation(extra, 'https://lcs.dynamics.com/'), undefined);
    assert.equal(checkNavigation(extra, 'https://sts.contoso.com/adfs'), undefined);
    assert.equal(checkNavigation(extra, 'https://contoso.com/'), undefined);
    assert.match(checkNavigation(extra, 'https://other.dynamics.com/') ?? '', /not allowed/);
    assert.ok(allowedHosts(extra).includes('lcs.dynamics.com'));
  });

  it('keeps company deep links inside the test legal entity', () => {
    assert.equal(checkNavigation(cfg, `${BASE}/?cmp=usmf&mi=x`), undefined);
    assert.match(checkNavigation(cfg, `${BASE}/?cmp=DEMF`) ?? '', /company 'DEMF'.*'USMF'/);
    assert.equal(checkNavigation(cfg, `${BASE}/?cmp=DEMF`, 'DEMF'), undefined, 'per-test legal entity wins');
    assert.match(checkNavigation(cfg, `${BASE}/?cmp=USMF`, 'DEMF') ?? '', /USMF.*'DEMF'/);
  });

  it('with no configured host, only sign-in pages and extras pass', () => {
    const none = { D365_BASE_URL: undefined, D365_COMPANY: 'USMF' };
    assert.equal(checkNavigation(none, 'https://login.microsoftonline.com/'), undefined);
    assert.match(checkNavigation(none, BASE) ?? '', /not allowed/);
  });
});
