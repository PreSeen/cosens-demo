import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readConfig, ConfigError, DEFAULT_SCOPES} from '../server/demo/config.mjs';

const kv = {get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({keys: [], list_complete: true})};
const secret = 'test-secret-0123456789abcdef0123456789abcdef';
function env(overrides = {}) {
  return {
    DEMO_MEMORY_BASE: 'https://memory.test',
    DEMO_ACCOUNT_BASE: 'https://account.test',
    DEMO_RSI_BASE: 'https://rsi.test/api',
    DEMO_LLM_BASE: 'https://llm.test/v1',
    DEMO_LLM_MODEL: 'test-model',
    DEMO_SESSION_SECRET: secret,
    DEMO_KV: kv,
    ...overrides,
  };
}

test('default scope string requests every demo scope', () => {
  assert.equal(DEFAULT_SCOPES, 'openid email offline_access memory.read memory.write memory.document.upload vu.manage rsi.read rsi.write llm.invoke');
});

test('a complete env becomes a Config with defaults', () => {
  const cfg = readConfig(env());
  assert.deepEqual(Object.keys(cfg).sort(), ['accountBase', 'clientId', 'kv', 'llmBase', 'llmModel', 'memoryBase', 'memoryViaGateway', 'oauthBase', 'oauthResource', 'rsiBase', 'scopes', 'secret']);
  assert.equal(cfg.memoryBase, 'https://memory.test');
  assert.equal(cfg.accountBase, 'https://account.test');
  assert.equal(cfg.rsiBase, 'https://rsi.test/api');
  assert.equal(cfg.llmBase, 'https://llm.test/v1');
  assert.equal(cfg.llmModel, 'test-model');
  assert.equal(cfg.scopes, DEFAULT_SCOPES);
  assert.equal(cfg.clientId, null);
  assert.equal(cfg.oauthBase, 'https://account.test');
  assert.equal(cfg.oauthResource, 'https://memory.test/mcp/');
  assert.equal(cfg.memoryViaGateway, false);
  assert.equal(cfg.secret, secret);
  assert.equal(cfg.kv, kv);
});

test('trailing slashes and surrounding spaces are stripped from every base URL', () => {
  const cfg = readConfig(env({
    DEMO_MEMORY_BASE: ' https://memory.test/// ',
    DEMO_ACCOUNT_BASE: 'https://account.test/',
    DEMO_RSI_BASE: 'https://rsi.test/api/',
    DEMO_LLM_BASE: 'https://llm.test/v1//',
    DEMO_LLM_MODEL: ' test-model ',
  }));
  assert.equal(cfg.memoryBase, 'https://memory.test');
  assert.equal(cfg.accountBase, 'https://account.test');
  assert.equal(cfg.rsiBase, 'https://rsi.test/api');
  assert.equal(cfg.llmBase, 'https://llm.test/v1');
  assert.equal(cfg.llmModel, 'test-model');
});

test('scope override is normalised to single spaces and client id is optional', () => {
  const cfg = readConfig(env({DEMO_OAUTH_SCOPES: '  openid\n memory.read   rsi.read ', DEMO_OAUTH_CLIENT_ID: ' client_123 '}));
  assert.equal(cfg.scopes, 'openid memory.read rsi.read');
  assert.equal(cfg.clientId, 'client_123');
  assert.equal(readConfig(env({DEMO_OAUTH_SCOPES: '   ', DEMO_OAUTH_CLIENT_ID: ''})).scopes, DEFAULT_SCOPES);
  assert.equal(readConfig(env({DEMO_OAUTH_CLIENT_ID: '  '})).clientId, null);
});

for (const name of ['DEMO_MEMORY_BASE', 'DEMO_ACCOUNT_BASE', 'DEMO_RSI_BASE', 'DEMO_LLM_BASE', 'DEMO_LLM_MODEL', 'DEMO_SESSION_SECRET', 'DEMO_KV']) {
  test(`missing ${name} throws config_missing naming the variable`, () => {
    for (const value of [undefined, '', '   ']) {
      if (name === 'DEMO_KV' && typeof value === 'string') continue;
      assert.throws(() => readConfig(env({[name]: value})), (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err instanceof Error);
        assert.equal(err.name, 'ConfigError');
        assert.equal(err.code, 'config_missing');
        assert.match(err.message, new RegExp(name));
        return true;
      });
    }
  });
}

test('a KV binding without get/put is treated as missing', () => {
  assert.throws(() => readConfig(env({DEMO_KV: {}})), {code: 'config_missing', message: /DEMO_KV/});
});

test('a missing env object throws config_missing instead of a TypeError', () => {
  assert.throws(() => readConfig(undefined), {code: 'config_missing', message: /DEMO_MEMORY_BASE/});
});

test('base URLs must be https, except http on localhost', () => {
  assert.throws(() => readConfig(env({DEMO_RSI_BASE: 'not a url'})), {code: 'config_invalid', message: /DEMO_RSI_BASE/});
  assert.throws(() => readConfig(env({DEMO_MEMORY_BASE: 'http://memory.test'})), {code: 'config_invalid', message: /DEMO_MEMORY_BASE/});
  assert.throws(() => readConfig(env({DEMO_LLM_BASE: 'ftp://llm.test/v1'})), {code: 'config_invalid', message: /DEMO_LLM_BASE/});
  assert.equal(readConfig(env({DEMO_MEMORY_BASE: 'http://localhost:9000/'})).memoryBase, 'http://localhost:9000');
  assert.equal(readConfig(env({DEMO_ACCOUNT_BASE: 'http://127.0.0.1:8080'})).accountBase, 'http://127.0.0.1:8080');
});

test('base URLs with a query or fragment are rejected', () => {
  assert.throws(() => readConfig(env({DEMO_RSI_BASE: 'https://rsi.test/api?x=1'})), {code: 'config_invalid', message: /DEMO_RSI_BASE/});
  assert.throws(() => readConfig(env({DEMO_LLM_BASE: 'https://llm.test/v1#a'})), {code: 'config_invalid', message: /DEMO_LLM_BASE/});
});

test('a session secret shorter than 32 characters is rejected without echoing it', () => {
  assert.throws(() => readConfig(env({DEMO_SESSION_SECRET: 'short-secret-value'})), (err) => {
    assert.equal(err.code, 'config_invalid');
    assert.match(err.message, /DEMO_SESSION_SECRET/);
    assert.equal(err.message.includes('short-secret-value'), false);
    return true;
  });
});

test('readConfig does not mutate env', () => {
  const input = env({DEMO_MEMORY_BASE: 'https://memory.test/'});
  const copy = {...input};
  readConfig(input);
  assert.deepEqual(input, copy);
});

test('DEMO_OAUTH_BASE overrides the OAuth server base and is checked like the other bases', () => {
  const cfg = readConfig(env({DEMO_OAUTH_BASE: ' https://oauth.test/ '}));
  assert.equal(cfg.oauthBase, 'https://oauth.test');
  assert.equal(cfg.accountBase, 'https://account.test');
  assert.equal(readConfig(env({DEMO_OAUTH_BASE: '  '})).oauthBase, 'https://account.test');
  assert.equal(readConfig(env({DEMO_ACCOUNT_BASE: 'https://account.test/'})).oauthBase, 'https://account.test');
  assert.throws(() => readConfig(env({DEMO_OAUTH_BASE: 'http://oauth.test'})), {code: 'config_invalid', message: /DEMO_OAUTH_BASE/});
  assert.throws(() => readConfig(env({DEMO_OAUTH_BASE: 'https://oauth.test/?a=1'})), {code: 'config_invalid', message: /DEMO_OAUTH_BASE/});
});

test('DEMO_OAUTH_RESOURCE is kept exactly, trailing slash included, and must be an https URL', () => {
  assert.equal(readConfig(env({DEMO_OAUTH_RESOURCE: ' https://rsi.test/mcp '})).oauthResource, 'https://rsi.test/mcp');
  assert.equal(readConfig(env({DEMO_OAUTH_RESOURCE: 'https://memory.test/mcp/'})).oauthResource, 'https://memory.test/mcp/');
  assert.equal(readConfig(env({DEMO_MEMORY_BASE: 'https://memory.test///'})).oauthResource, 'https://memory.test/mcp/');
  for (const value of ['not a url', 'http://rsi.test/mcp', 'https://rsi.test/mcp?x=1', 'https://rsi.test/mcp#a']) {
    assert.throws(() => readConfig(env({DEMO_OAUTH_RESOURCE: value})), {code: 'config_invalid', message: /DEMO_OAUTH_RESOURCE/});
  }
});

test('DEMO_MEMORY_VIA_GATEWAY is a true/false switch, off by default', () => {
  for (const value of ['true', 'TRUE', ' 1 ', true]) {
    assert.equal(readConfig(env({DEMO_MEMORY_VIA_GATEWAY: value, DEMO_OAUTH_RESOURCE: 'https://rsi.test/mcp'})).memoryViaGateway, true, String(value));
  }
  for (const value of [undefined, '', 'false', 'False', '0', false]) {
    assert.equal(readConfig(env({DEMO_MEMORY_VIA_GATEWAY: value})).memoryViaGateway, false, String(value));
  }
  for (const value of ['yes', 'on', '2']) {
    assert.throws(() => readConfig(env({DEMO_MEMORY_VIA_GATEWAY: value})), {code: 'config_invalid', message: /DEMO_MEMORY_VIA_GATEWAY/});
  }
});

test('Memory through the gateway needs an explicit DEMO_OAUTH_RESOURCE (the gateway base has no MCP resource)', () => {
  assert.throws(() => readConfig(env({DEMO_MEMORY_VIA_GATEWAY: 'true'})), {code: 'config_missing', message: /DEMO_OAUTH_RESOURCE/});
  const cfg = readConfig(env({DEMO_MEMORY_VIA_GATEWAY: 'true', DEMO_MEMORY_BASE: 'https://rsi.test/api', DEMO_OAUTH_RESOURCE: 'https://rsi.test/mcp'}));
  assert.deepEqual([cfg.memoryBase, cfg.oauthResource, cfg.memoryViaGateway], ['https://rsi.test/api', 'https://rsi.test/mcp', true]);
});
