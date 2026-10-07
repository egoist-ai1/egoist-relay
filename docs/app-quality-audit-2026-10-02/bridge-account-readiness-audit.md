# Relay account proof: source audit и bounded synthetic reproduction

**Current installed1.4.2 возвращает transient proof pending, затем ready;22/22 synthetic checks прошли. Два queue-handling отказа воспроизведены без source run. Production не менялась.**

Родительский30s status receipt содержит13 samples: Telegram ready всегда; X/Instagram pending на532ms, ready на3086ms; ready до15684ms, pending на18173ms, снова ready на20666ms и30758ms. Это parent evidence, этот worker live status не запрашивал. Текущий owner46312, birth2026-10-02T03:14:59.6525810Z; daemon9116/source8bbbb58e8063d507d121c96db644973b751a59cf3a593a8bde98b5b5615769c3. UI signed-in ранее подтверждён человеком; status proof является отдельной проверкой.

[Public pilot receipt](<C:\Users\Egoist\Desktop\Проекты\Приложения\Egoist Relay\docs\app-quality-audit-2026-10-02\public-operation-pilots.md:15>) также фиксирует успешный Xdiscover `51ec3a51-3c3d-4697-9f71-eedade0830b1`,2 records partial, затем idle proof_pending. Повторных platform jobs в этом аудите нет.

## Проверенные исходники

| Источник | SHA256 | Bytes |
| --- | --- | --- |
| installed-public-script | `892b7a56c9051212121beacf7e4cfc4b91956d2cbc91c072cd9d2091ab2b9338` | 31561 |
| candidate-public-script | `162335eccc2d6ff1676cd6fc069ce9b62bef077d89a4857ace392ade9450ddd8` | 34188 |
| candidate-native | `b4f41ae73fdd9406887815deec2c945603b03ff952395f16ca80960e1c49dbca` | 67149 |
| adapter-source | `9c2454c190fbcc23704b4cc4621cc542c052853017716c9403e35f445b59a952` | 20633 |
| broker-source | `e795c2b76929a2acf220c9e63c4855afc4e217212c6f0192ec5674d7ba7aec03` | 34846 |
| synthetic-fixture | `f6f5156739145884f0e53d75a21692dcaa2a00505e6c31f54585e5ad927a5d11` | 13404 |
| peer-public-receipt | `3ef04476dc880519e6db456e44a0b636eeda719dcd033185bfe9ccf63033f723` | 55299 |

Native использует compile-time `include_str!("../../runtime/research/social-read.js")`, research_social.rs:16. Наличие нового public файла не меняет уже загруженный EXE. authProof/waitAuth installed/candidate совпадают после нормализации LF/CRLF; raw file hashes выше различаются.

## Selectors, events и deadlines

- JS: top-frame only, first-party HTTPS; provider `x/twitter.com` либо `instagram.com`, social-read.js:4–7.
- X own-account proof: `[data-testid="SideNav_AccountSwitcher_Button"]` и `a[data-testid="AppTabBar_Profile_Link"]`, canonical own handle1–15 символов; login markers отдельны,75–95.
- Instagram: `/direct/inbox` link вне `main,[role="main"],article,[role="dialog"],[role="feed"]`; один own profile link в первых500 links: Profile/Профиль label/icon либо nav/header/navigation+img; canonical handle1–30, excluded reserved paths. Missing inbox/profile и ambiguous identity возвращают разные причины,97–124. Fixture не подтверждает селекторы фактического текущего DOM.
- `waitAuth`:15s либо remaining job budget,150ms poll. Нет ветки по document.hidden/visibilityState/readyState,130–138.
- Native status: при отсутствии active job и last_probe старше15s queue warm probe20s, state→initializing/DOM_ACCOUNT_PROOF_PENDING ДО pump,1347–1387. Adapter показывает initializing как unavailable, bridge-provider.mjs:41–43.
- Wry0.57 Started=`ContentLoading`, Finished=`NavigationCompleted`, webview2/mod.rs:714–732. Started повышает document_epoch; Phase::Probe вызывает begin_document; Finished остаётся fallback, research_social.rs:815–835.
- Native successful probe очищает active без закрытия WebView,1953–1964. Deadline/cancel закрывает только owned hidden view; close settlement очищает readiness,1160–1233. Window/view скрытые, unfocused; нет logout/удаления профиля в этом lifecycle,784–845.
- Storage listener действует только при active job; любой null key или regex auth/login/logout/session/account/current-user/user-id отменяет active как STALE_ACCOUNT, даже oldValue===newValue;605–609.1.4.3 исправляет pause error taxonomy, но predicate unchanged. Это консервативная account-boundary политика, не доказанный live false-positive.
- Reply guard сохраняет exact view label, first-party page URL=current source, requestId/nonce/documentEpoch/deadline, expectedAccount и own identity,1640–1793. Внешний status не раскрывает настоящую identity.

<a id="bridge-readiness-ttl-live"></a>

## Повторный TTL proof является переходным состоянием

После15 секунд native очищает ready→initializing перед новой скрытой proof; adapter показывает unavailable/dom_account_proof_pending.13 parent live samples на1.4.2 подтверждают обе платформы ready спустя≈2.5 секунды, включая повторный TTL refresh. Pending не является доказательством logout.

Evidence: [research_social.rs:1347](<C:\Users\Egoist\Desktop\Проекты\Приложения\Egoist Relay\tauri\src\research_social.rs:1347>), [bridge-provider.mjs:41](<C:\Users\Egoist\Desktop\Проекты\Инфраструктура\Egoist Social MCP\src\research\bridge-provider.mjs:41>).

<a id="bridge-readiness-queued-ttl"></a>

## Queued job преждевременно завершается во время proof refresh

Готовая bound submission сдвинута на16s перед dequeue. Actual native TTL contract в synthetic provider возвращает initializing; actual adapter и broker завершают PROVIDER_UNAVAILABLE,0source executions. Execute ждёт только provider_busy.

Evidence: [broker.mjs:354](<C:\Users\Egoist\Desktop\Проекты\Инфраструктура\Egoist Social MCP\src\research\broker.mjs:354>), [relay-account-readiness-audit.test.mjs:129](<C:\Users\Egoist\Desktop\Проекты\Приложения\Egoist Relay\docs\app-quality-audit-2026-10-02\relay-account-readiness-audit.test.mjs:129>).

<a id="bridge-readiness-submit-pin"></a>

## Submission pending→ready не получает account pin

Actual submit во время pending сохраняет accountScope undefined. Если dequeue уже ready под той же synthetic epoch, actual binding guard завершает STALE_ACCOUNT до source run. Это отсутствующий pin, а не подтверждённая смена аккаунта.

Evidence: [broker.mjs:468](<C:\Users\Egoist\Desktop\Проекты\Инфраструктура\Egoist Social MCP\src\research\broker.mjs:468>), [broker.mjs:372](<C:\Users\Egoist\Desktop\Проекты\Инфраструктура\Egoist Social MCP\src\research\broker.mjs:372>).

<a id="bridge-readiness-started-init"></a>

## Early ContentLoading dispatch может стать silent noop

Wry Started=ContentLoading. SDK допускает ContentLoading до document-created scripts, ExecuteScript асинхронен около этого этапа. Exact native optional wrapper выполненный до init возвращает undefined; actual script init сам не повторяет dispatch; только delayed Finished повтор запускает proof. Windows ordering текущего владельца не наблюдался этим fixture, поэтому это воспроизводимый source hazard, не доказанная причина каждого live pending.

Evidence: [research_social.rs:815](<C:\Users\Egoist\Desktop\Проекты\Приложения\Egoist Relay\tauri\src\research_social.rs:815>), [research_social.rs:896](<C:\Users\Egoist\Desktop\Проекты\Приложения\Egoist Relay\tauri\src\research_social.rs:896>), [mod.rs:714](<C:\Users\Egoist\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f\wry-0.57.0\src\webview2\mod.rs:714>).

<a id="bridge-readiness-hidden-and-guards"></a>

## Скрытый DOM и строгие границы аккаунта

Оба actual scripts подтверждают скрытые/loading X/IG документы при valid own nav. Missing/ambiguous IG nav, login/challenge и storage invalidation остаются отдельными результатами. Нативные nonce/origin/documentEpoch/expectedAccount guards сохраняются. Hidden WebView способен throttle tasks по SDK, но реальный scheduler/selector причины текущего владельца не наблюдались.

Evidence: [social-read.js:75](<C:\Users\Egoist\Desktop\Проекты\Приложения\Egoist Relay\runtime\research\social-read.js:75>), [research_social.rs:1650](<C:\Users\Egoist\Desktop\Проекты\Приложения\Egoist Relay\tauri\src\research_social.rs:1650>).

<a id="bridge-readiness-candidate-gate"></a>

## 1.4.3 не меняет proof lifecycle и остаётся отдельным live gate

authProof/waitAuth и storage regex идентичны после LF/CRLF normalization.1.4.3 изменяет pause abort taxonomy, original-photo selection, checked cursor retry и native selected IG routes; текущая proof TTL/dispatch/broker transient handling не исправляется. Live1.4.3 account readiness/collection в данном этапе не запускались.

Evidence: [relay-account-readiness-audit.test.mjs:70](<C:\Users\Egoist\Desktop\Проекты\Приложения\Egoist Relay\docs\app-quality-audit-2026-10-02\relay-account-readiness-audit.test.mjs:70>).

## Причина двух queued failures

Actual broker проверяет readiness ещё раз при dequeue. `execute` ждёт только unavailable/provider_busy (100ms); proof pending даёт PROVIDER_UNAVAILABLE и0 source calls, broker.mjs:354–368. Submit pin получен только в ready/provider_busy,468–472. Submission during pending не сохраняет accountScope; даже если proof уже ready к execute под той же epoch, guard372–373 возвращает STALE_ACCOUNT из-за отсутствующего scope. Genuine changed epoch остаётся отдельным правильным STALE_ACCOUNT отказом.

Fixture использует actual adapter+broker+JobStore и synthetic provider/timing. TTL15s извлечён из actual native source, native status transition моделируется. Изолированные stores создаются только в explicit own task work. Никакой daemon/Relay/platform transport не вызывается.

## Early dispatch: что доказано и что нет

Exact native optional expression перед init возвращает undefined без error/auth reply. Actual init устанавливает API, но не запускает потерянный envelope и не создаёт retry timer. Повтор expression после delayed Finished возвращает ready. Это подтверждается на installed и candidate actual scripts.

[Microsoft ContentLoading](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2#add_contentloading) описывает event перед document-created scripts; [ExecuteScript](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2#executescript) выполняется асинхронно около этого этапа. Поэтому source разрешает такой lost dispatch ordering. Fixture не запускает WebView2 COM и не доказывает, что каждая текущая pending probe исполнилась в этом порядке. Source ordering hazard и наблюдаемый TTL transient остаются отдельными выводами.

[WebView2 visibility](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller#get_isvisible) допускает throttling некоторых hidden-page задач. Actual hidden/loading DOM fixture с правильной own navigation ready в обоих scripts; скрытие само по себе не означает logout. Реальный scheduler и текущий platform DOM не наблюдались.

## Минимальные предложения, пока без production edits

1. Bounded coalesced settled-readiness wait ДО submit pin и при dequeue для явного proof_pending/app_initializing transient. Status snapshot остаётся честным. Stop на settled auth/challenge/rate-limit/transport error; remaining deadline finite. Операция source не повторяется. Если ранее pinned account/epoch изменён, STALE_ACCOUNT остаётся обязательным.
2. Windows Phase::Probe dispatch через current NavigationId/source/documentEpoch-bound DOMContentLoaded после init с Finished fallback. В проекте уже есть SDK pattern `multi_app.rs:715–778`. Не использовать UI label/state для research и не начать collection extraction раньше source readiness.

Постоянный stale ready, снятие account checks, cookie/profile обход, foreground activation и browser flags для отключения throttling не предлагаются.

1.4.3 меняет original-photo selection, checked cursor_no_progress recovery, native IG routes и pause abort taxonomy. Этот candidate не содержит proof TTL/dispatch/broker settled-readiness fix. Его live приёмка в данном этапе не выполнялась; обновлённый EXE активируется отдельно после normal user exit.

## Проверка

22 passed,0 failed,0 skipped; fixture wall446.8214ms. Synthetic timers ускорены:600ms hydration и15000ms negative proof являются fake elapsed, не сервисной скоростью. Есть положительные контроли hidden X/IG, delayed nav, provider_busy→ready с1 run; отрицательные genuine epoch change, missing/ambiguous own nav, login/challenge, account storage invalidation и cancel без late auth.

Команда для повторения: Node24 `--test --test-concurrency=1 relay-account-readiness-audit.test.mjs`, с `EGOIST_RESEARCH_TEST_WORK` равным work фактической текущей задачи. Проверяется exact installed/candidate public SHA. После изменения production inputs audit fixture/receipt требуют новой версии, нельзя переносить старый PASS на новый EXE.

## Обратная связь

Авторитетный снимок: [bridge-account-readiness-audit.json](bridge-account-readiness-audit.json). SHA256 exact bytes: `9d6404bf1c64c0c64e4c149c09e8ee196c9218bcb2b0ae6765750534b55fa22a`.

Шесть exact reviewObjects подготовлены для общего parent companion review board. Для каждого: нейтральный ✓ Да / подтверждаю, ✕ Нет, ? Поясни и комментарий; общий комментарий и Применить. Подтверждение принимает указанный finding либо отдельно сформулированную scoped доработку; не запускает install/login/platform job. Ответы сохраняются отдельно, без выбранного решения по умолчанию.

Новых артефактов только три: JSON, Markdown и named synthetic fixture. Production/native/helper/package/deps/profile/settings/network/processes неизменяемы этим worker. Остаточный live gate: новая сборка после разрешённого owner transition, idle>15s→submit/dequeue без ложных ошибок, slow Finished→DOM proof до20s, cancelled/old navigation/account epoch replies всё ещё отклоняются.
