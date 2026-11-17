import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configureNetwork, proxyFromEnv, proxyFromRule, redactProxy, withLocalNoProxy } from './network.js';

describe('configureNetwork', () => {
  const certs = (system: string[], fail = false) => {
    const set: string[][] = [];
    return {
      set,
      apis: {
        getCACertificates: (type: string) => {
          if (type === 'system' && fail) throw new Error('keychain locked');
          return type === 'system' ? system : ['bundled-a', 'bundled-b'];
        },
        setDefaultCACertificates: (c: string[]) => void set.push(c),
      },
    };
  };

  it('adds only the system certificates Node does not already trust', () => {
    const { set, apis } = certs(['bundled-a', 'corp-root']);
    const setup = configureNetwork({}, apis);
    assert.equal(setup.systemCertificates, 1);
    assert.deepEqual(set, [['bundled-a', 'bundled-b', 'corp-root']]);
    assert.deepEqual(setup.notes, []);
  });

  it('leaves the trust list alone when the system adds nothing, or when turned off', () => {
    const none = certs(['bundled-a']);
    assert.equal(configureNetwork({}, none.apis).systemCertificates, 0);
    assert.deepEqual(none.set, []);
    const disabled = certs(['corp-root']);
    configureNetwork({ D365FO_SYSTEM_CA: 'false' }, disabled.apis);
    assert.deepEqual(disabled.set, []);
  });

  it('reports, but survives, an unreadable store or an old Node', () => {
    const broken = configureNetwork({}, certs([], true).apis);
    assert.match(broken.notes[0], /keychain locked.*NODE_EXTRA_CA_CERTS/);
    assert.match(configureNetwork({}, {}).notes[0], /cannot read the system certificate store/);
  });

  it('routes through the environment proxy and keeps local services direct', () => {
    let given: NodeJS.ProcessEnv | undefined;
    const env: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://user:pw@proxy.corp:8080', NO_PROXY: '.corp.local' };
    const setup = configureNetwork(env, { setGlobalProxyFromEnv: (e) => (given = e) });
    assert.equal(setup.proxy, 'http://user:pw@proxy.corp:8080');
    assert.equal(given?.NO_PROXY, '.corp.local,localhost,127.0.0.1,::1');
    assert.equal(env.NO_PROXY, '.corp.local,localhost,127.0.0.1,::1', 'child processes inherit the loopback exclusion');
  });

  it('does nothing about proxies when none is set', () => {
    let called = false;
    assert.equal(configureNetwork({}, { setGlobalProxyFromEnv: () => (called = true) }).proxy, undefined);
    assert.equal(called, false);
  });
});

describe('proxy helpers', () => {
  it('prefers HTTPS_PROXY and ignores blanks', () => {
    assert.equal(proxyFromEnv({ HTTPS_PROXY: ' ', http_proxy: 'http://p:3128' }), 'http://p:3128');
    assert.equal(proxyFromEnv({}), undefined);
  });

  it('adds loopback hosts once', () => {
    assert.equal(withLocalNoProxy(undefined), 'localhost,127.0.0.1,::1');
    assert.equal(withLocalNoProxy('localhost, intranet'), 'localhost,intranet,127.0.0.1,::1');
  });

  it('hides proxy passwords', () => {
    assert.equal(redactProxy('http://me:secret@proxy:8080'), 'http://me:***@proxy:8080');
    assert.equal(redactProxy('proxy:8080'), 'proxy:8080');
  });

  it('reads Chromium proxy rules', () => {
    assert.equal(proxyFromRule('PROXY proxy.corp:8080; DIRECT'), 'http://proxy.corp:8080');
    assert.equal(proxyFromRule('HTTPS secure.corp:443'), 'https://secure.corp:443');
    assert.equal(proxyFromRule('DIRECT'), undefined);
    assert.equal(proxyFromRule('SOCKS5 s:1080; DIRECT'), undefined);
    assert.equal(proxyFromRule(undefined), undefined);
  });
});
