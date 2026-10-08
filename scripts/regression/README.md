# Network regression checks

Relay 1.3.1 inherits Windows network settings. The internal gateway, DNS helper, Telegram bridge and their obsolete fixtures were removed. Run current media and installer tests from the project root with `EGOIST_RELAY_AUDIT_WORK` set to your task work directory:

```powershell
node --test scripts/media-proxy.test.mjs scripts/social-media-fetch.test.mjs scripts/release-policy.test.mjs scripts/release-installer.test.mjs
```

The remainder of this document describes historical 1.3.0 fixtures and is not a current test command.

## Historical network fixtures (1.3.0)

Run from the project root with Node 24 or 26 and existing project dependencies:

```powershell
$env:EGOIST_RELAY_AUDIT_WORK = '<absolute path to your task work directory>'
node --test scripts/regression/app-proxy.test.mjs scripts/regression/proxy-bridge.test.mjs
```

`EGOIST_RELAY_TEST_WORK` is accepted as a compatibility alias. Temporary source copies, fixture bundles and process logs go only into that directory. Tests create and close their own loopback listeners and child processes. They do not use accounts, personal provider URLs, system network configuration or public Telegram endpoints.

The gateway suite injects a resolver and local SOCKS backend through the source factory. A separate case guards the production socket path. The bridge suite records official Telegram CONNECT target bytes and forwards only to its own local encrypted DC fixture. Every SOCKS bridge case has guards against direct TCP and external OS DNS.

Deadline/cooldown gateway cases use a temporary source copy with 15/30 seconds reduced to 150 ms. The bridge heartbeat pressure case reduces 30 seconds to 200 ms; its truncated SOCKS case reduces 5 seconds to 200 ms. These cases verify behavior and byte order, not WAN latency or availability. The gateway capacity case reaches 504 SOCKS handshakes in batches of 24 and verifies that health retains capacity.

Real TLS/DoH wire tests are maintained by the DNS/media audit. Native process ownership, application WebViews, real providers, global VPN coexistence and the installer require separate release gates.

## Explicit live connectivity audit

`network-connectivity.mjs` is a separate opt-in diagnostic. It receives the selected DNS profile envelope (`schemaVersion: 1`, `providerUrl`) only through bounded stdin; callers must keep any DPAPI unsealing in RAM and avoid shell arguments, environment variables or plaintext files for the URL. It creates its own ciadpi backends and gateway listeners, compares three fixed TCP strategies, requests public Telegram HTTPS hosts and probes numeric DC TCP 443. It emits only public target names/addresses and static error codes.

The optional `--ports-wss` mode probes three public WSS hostnames over HTTPS and DC TCP 80/5222 with a 5-second deadline. The 5222 probe uses its own numeric SOCKS backend; the production gateway's 80/443 policy is unchanged. It does not perform WebSocket upgrade, MTProto login or account actions. Active global network software remains a possible influence; no services or settings are changed.
