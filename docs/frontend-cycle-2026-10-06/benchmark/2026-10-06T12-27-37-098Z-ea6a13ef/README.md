# Relay: paired browser benchmark

Run: 2026-10-06T12-27-37-098Z-ea6a13ef. Status: **completed**. 3 pairs, 20 observations per metric per batch.

All comparisons use the same installed Edge, isolated profiles, existing synthetic fixture, viewport and warmup. This report makes no live-network, delivery-quality or physical GPU claim.

Source package versions: baseline 1.5.0, candidate 1.6.0. Shared APP_VERSION macro: 1.6.0.

| Metric | Baseline median [min; max] | Candidate median [min; max] | Ratio | >10% beyond spread |
|---|---:|---:|---:|---|
| open-chat-101 | 29.850 [27.050; 30.250] ms | 27.500 [27.150; 29.750] ms | 0.921 | No flag |
| ctrl-j-saved-history | 135.100 [134.800; 135.400] ms | 135.350 [134.400; 136.000] ms | 1.002 | No flag |
| dispatch-saved-file-open | 13.950 [13.700; 14.100] ms | 13.650 [13.550; 13.950] ms | 0.978 | No flag |
| ctrl-j-close-history | 12.700 [12.400; 13.150] ms | 13.300 [12.850; 13.800] ms | 1.047 | No flag |
| switch-x | 34.450 [34.000; 34.550] ms | 34.600 [34.600; 34.900] ms | 1.004 | No flag |
| switch-instagram | 35.400 [35.300; 36.100] ms | 36.050 [35.250; 40.200] ms | 1.018 | No flag |
| switch-telegram | 35.600 [35.400; 35.700] ms | 35.850 [35.650; 35.950] ms | 1.007 | No flag |
| ctrl-j-current | 134.400 [134.250; 134.850] ms | 134.900 [134.400; 134.950] ms | 1.004 | No flag |
| select-history | 13.900 [13.850; 14.050] ms | 14.000 [13.700; 14.050] ms | 1.007 | No flag |
| ctrl-j-close-after-section-switch | 13.650 [13.250; 14.250] ms | 13.500 [13.050; 13.750] ms | 0.989 | No flag |
| browser-tree-cpu | unavailable | unavailable | incomplete | Unverified |
| browser-cdp-cpu-crosscheck | unavailable | unavailable | incomplete | Unverified |
| browser-tree-endpoint-private | 932892672.000 [920514560.000; 1843482624.000] bytes | 885534720.000 [883810304.000; 897355776.000] bytes | 0.949 | No flag |

A flag requires ratio >1.10 and no overlap between the three candidate batch medians and three baseline batch medians. Absence of a flag is not proof of equality. Raw per-action observations and exact source identities accompany this report.

CPU: Windows PID/PPID subtree from CDP browser PID; Get-Process CPU/PrivateMemorySize64; CDP CPU cross-check. CPU coverage: CPU comparisons require unchanged complete process membership; missing/exited processes are explicitly gated.

Private bytes describe endpoint snapshots. CPU Windows probes and CDP cross-check use different, explicitly recorded brackets; they must not be mixed into a single number.

## Settled geometry at 1100 × 800

- baseline repeat 1, reading: [image](1-baseline-reading-1100.png), geometry in batch-1-baseline.json
- baseline repeat 1, profile: [image](1-baseline-profile-1100.png), geometry in batch-1-baseline.json
- baseline repeat 1, profile-panel: [image](1-baseline-profile-panel-1100.png), geometry in batch-1-baseline.json
- candidate repeat 1, reading: [image](1-candidate-reading-1100.png), geometry in batch-1-candidate.json
- candidate repeat 1, profile: [image](1-candidate-profile-1100.png), geometry in batch-1-candidate.json
- candidate repeat 1, profile-panel: [image](1-candidate-profile-panel-1100.png), geometry in batch-1-candidate.json
- candidate repeat 2, reading: [image](2-candidate-reading-1100.png), geometry in batch-2-candidate.json
- candidate repeat 2, profile: [image](2-candidate-profile-1100.png), geometry in batch-2-candidate.json
- candidate repeat 2, profile-panel: [image](2-candidate-profile-panel-1100.png), geometry in batch-2-candidate.json
- baseline repeat 2, reading: [image](2-baseline-reading-1100.png), geometry in batch-2-baseline.json
- baseline repeat 2, profile: [image](2-baseline-profile-1100.png), geometry in batch-2-baseline.json
- baseline repeat 2, profile-panel: [image](2-baseline-profile-panel-1100.png), geometry in batch-2-baseline.json
- baseline repeat 3, reading: [image](3-baseline-reading-1100.png), geometry in batch-3-baseline.json
- baseline repeat 3, profile: [image](3-baseline-profile-1100.png), geometry in batch-3-baseline.json
- baseline repeat 3, profile-panel: [image](3-baseline-profile-panel-1100.png), geometry in batch-3-baseline.json
- candidate repeat 3, reading: [image](3-candidate-reading-1100.png), geometry in batch-3-candidate.json
- candidate repeat 3, profile: [image](3-candidate-profile-1100.png), geometry in batch-3-candidate.json
- candidate repeat 3, profile-panel: [image](3-candidate-profile-panel-1100.png), geometry in batch-3-candidate.json

## Limits

- Headless installed Edge with real Relay components, existing MockClient and terminal native mocks
- Remote HTTP/WebSocket requests are aborted; native account transport, actual downloads and Telegram sends are not exercised
- Saved-file action dispatch reaches a synthetic registered receipt; no disk file or external app is opened
- CPU and private bytes describe the complete identified browser process tree, excluding Node/Vite and native Tauri processes
- Private bytes are endpoint snapshots; observed maximum of two snapshots is not a continuously measured peak
- RAF response timing is a headless browser observation, not physical GPU/DPI smoothness or a 60 fps claim
- Current installed dependencies and the same audit harness are used for both source snapshots
- APP_VERSION uses current candidate package.json for both arms; the baseline is a frozen source overlay, not the historical packaged runtime
- Both arms use the same isolated audit Vite configuration (configFile:false); optional support configs are hashed only when present and missing files are listed
- Three repeats establish observed spread on this host; they are not a population-level confidence interval

## Contract sources

- [Chrome DevTools Protocol: SystemInfo/ProcessInfo](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json), checked 2026-10-06
- [Playwright: browser.newBrowserCDPSession](https://playwright.dev/docs/api/class-browser#browser-new-browser-cdp-session), checked 2026-10-06
- [Microsoft: Get-CimInstance](https://learn.microsoft.com/en-us/powershell/module/cimcmdlets/get-ciminstance?view=powershell-7.5), checked 2026-10-06
- [Microsoft: Get-Process](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/get-process?view=powershell-7.5), checked 2026-10-06
- [Microsoft: Process.PrivateMemorySize64](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.privatememorysize64?view=net-10.0), checked 2026-10-06

Reproduction: set RELAY_FRONTEND_BASELINE, RELAY_FRONTEND_BENCHMARK_OUTPUT and RELAY_FRONTEND_BENCHMARK_READY=1 after stabilizing sources and stopping parallel checks, then run `node scripts/relay-frontend-benchmark.mjs`.

The source overlay changes product source only; both arms use the current audit harness and installed dependencies. results.json retains data; source-identities.json records the exact inputs.
