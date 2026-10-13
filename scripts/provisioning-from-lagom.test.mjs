import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildProvisioning, discover, parseArgs, pickDoh, pickVpn, ProvisioningError, run } from './provisioning-from-lagom.mjs';

// Все значения выдуманы: зарезервированный домен .invalid, нулевые идентификаторы.
const node = (id, host, extra = {}) => ({ id, name: id, protocol: 'vless', server: host, port: 443, uri: `vless://00000000-0000-0000-0000-000000000000@${host}:443?type=tcp#${id}`, ...extra });
const profileV2 = () => ({
  schemaVersion: 1, revision: 3, activeNodeId: 'b',
  nodes: [node('a', 'a.example.invalid', { subscriptionId: 's1' }), node('b', 'b.example.invalid', { subscriptionId: 's1' }),
    node('c', 'c.example.invalid', { subscriptionId: 's2' }), { ...node('h', 'h.example.invalid', { subscriptionId: 's1' }), protocol: 'hysteria2', uri: 'hysteria2://x@h.example.invalid:443' }],
  subscriptions: [{ id: 's1', url: 'https://sub.example.invalid/fixture-token', enabled: true }, { id: 's2', url: 'https://sub2.example.invalid/x', enabled: true }],
  settings: { customDnsUrl: '' },
});
const desired = () => ({ schemaVersion: 1, dns: { mode: 'local', dohUrl: 'https://doh.example.invalid/dns-query' } });
const SECRETS = /example\.invalid|fixture-token|00000000-0000/;

test('pickVpn: активный узел первым, затем узлы его подписки, чужие схемы и чужие подписки пропускаются', () => {
  const links = pickVpn(profileV2()).split('\n');
  assert.equal(links.length, 2);
  assert.match(links[0], /@b\.example\.invalid/);
  assert.match(links[1], /@a\.example\.invalid/);
  assert.equal(pickVpn(profileV2(), { maxNodes: 1 }).split('\n').length, 1);
  assert.equal(pickVpn(profileV2(), { subscription: true }), 'https://sub.example.invalid/fixture-token');
  const loose = profileV2(); loose.nodes[1].subscriptionId = undefined;
  assert.equal(pickVpn(loose).split('\n').length, 1);
  assert.throws(() => pickVpn({ nodes: [{ id: 'x', uri: 'hysteria2://x@h:1' }] }), ProvisioningError);
  assert.throws(() => pickVpn({ nodes: [node('a', 'a.example.invalid')], subscriptions: [] }, { subscription: true }), /подписка не найдена/);
});

test('pickDoh: desired.json, затем customDnsUrl, затем systemDohUrl только при включённом', () => {
  assert.equal(pickDoh({ desired: desired(), state: { settings: { customDnsUrl: 'https://other.example.invalid/dns-query' } } }), 'https://doh.example.invalid/dns-query');
  assert.equal(pickDoh({ state: { settings: { customDnsUrl: 'https://custom.example.invalid/dns-query' } } }), 'https://custom.example.invalid/dns-query');
  assert.equal(pickDoh({ state: { settings: { systemDohEnabled: false, systemDohUrl: 'https://cloudflare.example.invalid/dns-query' } } }), '');
  assert.equal(pickDoh({ state: { settings: { systemDohEnabled: true, systemDohUrl: 'https://sys.example.invalid/dns-query' } } }), 'https://sys.example.invalid/dns-query');
  assert.equal(pickDoh({ desired: { dns: { dohUrl: 'http://insecure.example.invalid/dns-query' } } }), '');
});

test('buildProvisioning: формат ядра и сообщения об ошибках без значений', () => {
  const p = buildProvisioning({ state: profileV2(), desired: desired() });
  assert.deepEqual(Object.keys(p), ['schema', 'vpn', 'doh', 'mtproxy']);
  assert.equal(p.schema, 1);
  assert.equal(buildProvisioning({ state: profileV2(), desired: desired() }, { mtproxy: 'tg://proxy?server=m.example.invalid&port=1&secret=ee' }).mtproxy.startsWith('tg://proxy?'), true);
  assert.throws(() => buildProvisioning({ state: profileV2(), desired: null }), (e) => /DoH не найден/.test(e.message) && !SECRETS.test(e.message));
  for (const url of ['https://dns.nextdns.io/abc123', 'https://dns.controld.com/xyz', 'https://doh.example.invalid']) {
    assert.equal(buildProvisioning({ state: profileV2(), desired: { dns: { dohUrl: url } } }).doh, url);
  }
  for (const url of ['https://user:pw@doh.example.invalid/x', 'http://doh.example.invalid/x']) {
    assert.throws(() => buildProvisioning({ state: profileV2(), desired: { dns: { dohUrl: url } } }), (e) => !SECRETS.test(e.message) && !/pw@/.test(e.message));
  }
  assert.equal(buildProvisioning({ state: profileV2(), desired: null }, { doh: 'https://manual.example.invalid/dns-query' }).doh, 'https://manual.example.invalid/dns-query');
});

test('parseArgs: параметры и ошибки', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--force', '--subscription', '--max-nodes', '3', '--source', 'v1']),
    { dryRun: true, force: true, subscription: true, maxNodes: 3, source: 'v1' });
  for (const bad of [['--nope'], ['--max-nodes', '0'], ['--max-nodes'], ['--source', 'v3']]) assert.throws(() => parseArgs(bad), ProvisioningError);
});

async function lagomFixture({ v2 = true, v1 = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egoist-social-lagom-'));
  const env = { ProgramData: path.join(dir, 'pd'), APPDATA: path.join(dir, 'ad') };
  if (v2) {
    await mkdir(path.join(env.ProgramData, 'EgoLag', 'Core'), { recursive: true });
    await writeFile(path.join(env.ProgramData, 'EgoLag', 'Core', 'profile.json'), JSON.stringify(profileV2()));
    await writeFile(path.join(env.ProgramData, 'EgoLag', 'Core', 'desired.json'), JSON.stringify(desired()));
  }
  if (v1) {
    await mkdir(path.join(env.APPDATA, 'Egoist Shield'), { recursive: true });
    const state = { ...profileV2(), settings: { customDnsUrl: 'https://v1doh.example.invalid/dns-query' } };
    await writeFile(path.join(env.APPDATA, 'Egoist Shield', 'egoistshield-state.json'), JSON.stringify(state));
  }
  return { dir, env };
}

test('discover: v2 приоритетнее v1, без v2 берётся v1, пусто — понятная ошибка', async () => {
  const both = await lagomFixture({ v1: true });
  const v1only = await lagomFixture({ v2: false, v1: true });
  const none = await lagomFixture({ v2: false });
  try {
    assert.equal((await discover(both.env)).version, 'v2');
    assert.equal((await discover(both.env, 'v1')).version, 'v1');
    assert.equal((await discover(v1only.env)).version, 'v1');
    await assert.rejects(discover(none.env), /Lagom не найден/);
    await assert.rejects(discover(v1only.env, 'v2'), /v2 не найден/);
  } finally { for (const f of [both, v1only, none]) await rm(f.dir, { recursive: true, force: true }); }
});

test('run: dry-run не пишет файл; запись не перезаписывает без --force; сводка без значений', async () => {
  const { dir, env } = await lagomFixture({ v1: true });
  const out = path.join(dir, 'provisioning.local.json');
  try {
    const dry = await run(['--dry-run', '--out', out], env);
    await assert.rejects(readFile(out), { code: 'ENOENT' });
    assert.match(dry.join('\n'), /Lagom v2/);
    assert.match(dry.join('\n'), /vpn: ссылок 2, doh: да, mtproxy: нет/);
    const written = await run(['--out', out], env);
    assert.ok(!SECRETS.test([...dry, ...written].join('\n')), 'сводка не должна содержать значения');
    const file = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(file.schema, 1);
    assert.equal(file.doh, 'https://doh.example.invalid/dns-query');
    assert.equal(file.vpn.split('\n').length, 2);
    await assert.rejects(run(['--out', out], env), (e) => /не перезаписан/.test(e.message) && !SECRETS.test(e.message));
    assert.equal((await readFile(out, 'utf8')).includes('doh.example.invalid'), true, 'существующий файл не тронут');
    await run(['--out', out, '--force', '--subscription'], env);
    assert.equal(JSON.parse(await readFile(out, 'utf8')).vpn, 'https://sub.example.invalid/fixture-token');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('run: битый JSON Lagom не раскрывает содержимое', async () => {
  const { dir, env } = await lagomFixture();
  try {
    await writeFile(path.join(env.ProgramData, 'EgoLag', 'Core', 'profile.json'), '{"nodes":[{"uri":"vless://секрет@x.example.invalid');
    await assert.rejects(run(['--dry-run'], env), (e) => /не разобран/.test(e.message) && !/секрет|example/.test(e.message));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
