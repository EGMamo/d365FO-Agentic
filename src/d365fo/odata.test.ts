import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { AppConfig } from '../config/index.js';
import { buildODataUrl, errorDetail, ODataClient } from './odata.js';
import type { ODataTokenSource } from './odata-auth.js';

const ORIGIN = 'https://x.sandbox.operations.dynamics.com';
const cfg = { D365_BASE_URL: `${ORIGIN}/` } as AppConfig;
const source: ODataTokenSource = { mode: 'browser', async token() { return 'tok'; } };

describe('buildODataUrl', () => {
  it('builds a read-only query under /data with encoded options', () => {
    assert.equal(
      buildODataUrl(ORIGIN, { entity: 'VendorsV2', select: 'VendorAccountNumber, VendorGroupId', filter: "VendorAccountNumber eq 'US-101'", orderby: 'VendorAccountNumber desc', top: 5, company: 'usmf' }),
      `${ORIGIN}/data/VendorsV2?$top=5&$select=VendorAccountNumber%2CVendorGroupId&$filter=dataAreaId%20eq%20'USMF'%20and%20(VendorAccountNumber%20eq%20'US-101')&$orderby=VendorAccountNumber%20desc&cross-company=true`,
    );
  });

  it('defaults to 10 rows, caps at 25 and adds no company unless asked', () => {
    assert.equal(buildODataUrl(ORIGIN, { entity: 'LegalEntities' }), `${ORIGIN}/data/LegalEntities?$top=10`);
    assert.match(buildODataUrl(ORIGIN, { entity: 'LegalEntities', top: 500 }), /\$top=25$/);
  });

  for (const [what, q] of [
    ['an entity with a path', { entity: 'VendorsV2/../x' }],
    ['an entity with a query', { entity: 'VendorsV2?$expand=x' }],
    ['a select with a function', { entity: 'VendorsV2', select: 'a,b;drop' }],
    ['a filter that adds an option', { entity: 'VendorsV2', filter: "A eq 'x'&$top=1000" }],
    ['a filter with a fragment', { entity: 'VendorsV2', filter: 'A eq 1 # x' }],
    ['a filter with a dollar sign', { entity: 'VendorsV2', filter: '$select=x' }],
    ['an orderby with a path', { entity: 'VendorsV2', orderby: '../x' }],
    ['a company that is not an id', { entity: 'VendorsV2', company: "USMF' or 1 eq 1" }],
    ['a top below one', { entity: 'VendorsV2', top: 0 }],
    ['a top that is not a number', { entity: 'VendorsV2', top: Number.NaN }],
  ] as const) {
    it(`refuses ${what}`, () => assert.throws(() => buildODataUrl(ORIGIN, q), /not a data entity|must be|characters OData filters/));
  }
});

describe('ODataClient', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('reads with a GET and the bearer token, and drops the OData bookkeeping', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => { seen = { url, init }; return json({ '@odata.context': 'x', value: [{ '@odata.etag': 'W/1', VendorAccountNumber: 'US-101' }] }); }) as typeof fetch;
    const result = await new ODataClient(cfg, source).query({ entity: 'VendorsV2', select: 'VendorAccountNumber' });
    assert.deepEqual(result, { entity: 'VendorsV2', count: 1, rows: [{ VendorAccountNumber: 'US-101' }] });
    assert.equal(seen?.init.method, 'GET');
    assert.equal((seen?.init.headers as Record<string, string>).authorization, 'Bearer tok');
    assert.equal(seen?.init.body, undefined);
    assert.ok(seen?.url.startsWith(`${ORIGIN}/data/VendorsV2?`));
  });

  it('keeps long answers small and says so', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ Id: i, Text: 'x'.repeat(1500) }));
    globalThis.fetch = (async () => json({ value: rows })) as typeof fetch;
    const result = await new ODataClient(cfg, source).query({ entity: 'Big' });
    assert.ok(result.rows.length < 10 && JSON.stringify(result.rows).length <= 8000);
    assert.match(result.note ?? '', /Showing \d+ of 10 rows[\s\S]*select/);
  });

  it('turns refusals into plain messages', async () => {
    const reply = (status: number, body: unknown = {}) => { globalThis.fetch = (async () => json(body, status)) as typeof fetch; };
    const client = new ODataClient(cfg, source);
    reply(401);
    await assert.rejects(client.query({ entity: 'VendorsV2' }), /refused the data-access sign-in \(401\)[\s\S]*browser sign-in/);
    reply(403);
    await assert.rejects(client.query({ entity: 'VendorsV2' }), /not allowed to read this data over OData \(403\)/);
    reply(404);
    await assert.rejects(client.query({ entity: 'Vendors' }), /no data entity named 'Vendors'[\s\S]*case-sensitive/);
    reply(400, { error: { message: "Could not find a property named 'Foo' on type 'VendorV2'." } });
    await assert.rejects(client.query({ entity: 'VendorsV2', filter: 'Foo eq 1' }), /answered 400: Could not find a property named 'Foo'/);
  });

  it('reports the reason F&O keeps in innererror and never forwards its stack trace', async () => {
    const body = { error: { code: '', message: 'An error has occurred.', innererror: { message: "Could not find a property named 'NoSuchField' on type 'VendorV2'.", type: 'Microsoft.OData.Core.ODataException', stacktrace: '   at Microsoft.OData.Core.UriParser.Parsers.EndPathBinder' } } };
    globalThis.fetch = (async () => json(body, 400)) as typeof fetch;
    await assert.rejects(new ODataClient(cfg, source).query({ entity: 'VendorsV2', filter: 'NoSuchField eq 1' }), (e: Error) => /answered 400: Could not find a property named 'NoSuchField'/.test(e.message) && !/stacktrace|UriParser/.test(e.message));
    assert.equal(errorDetail('<html>Bad gateway</html>'), '<html>Bad gateway</html>');
    assert.equal(errorDetail(''), 'no details');
  });

  it('refuses a plain-http or missing F&O address', () => {
    assert.throws(() => new ODataClient({ D365_BASE_URL: 'http://x.example.com' } as AppConfig, source), /must be https/);
    assert.throws(() => new ODataClient({} as AppConfig, source), /No F&O address/);
  });

  it('checks the sign-in with one test read and names who is signed in', async () => {
    const claims = Buffer.from(JSON.stringify({ upn: 'jo@contoso.com' })).toString('base64url');
    const withUser: ODataTokenSource = { mode: 'azure-cli', async token() { return `h.${claims}.s`; } };
    globalThis.fetch = (async () => json({ value: [{ LegalEntityId: 'USMF' }] })) as typeof fetch;
    assert.deepEqual(await new ODataClient(cfg, withUser).check(), { ok: true, detail: `azure-cli sign-in as jo@contoso.com can read ${ORIGIN}/data` });
    const failing: ODataTokenSource = { mode: 'browser', async token() { throw new Error('Not signed in for data access yet.\nmore'); } };
    assert.deepEqual(await new ODataClient(cfg, failing).check(), { ok: false, detail: 'Not signed in for data access yet.' });
  });
});
