# Независимый аудит сетевой части Relay 1.2.6

Дата: 29 сентября 2026, Москва. Это свежая проверка текущих исходников перед 1.3.0; прежние отчёты не использованы как доказательство прохождения тестов.

Обновление реализации: 30 сентября 2026. NET-01–03 исправлены; для NET-04 добавлены безопасный выбор свободных неявных default ports и признак необходимости перезапуска при блокированном main route. Раздел «Реализация 1.3.0» ниже отделяет результаты исходного аудита от текущего поведения. NET-05 остаётся документированной bootstrap зависимостью.

## Область и метод

Проверены `tauri/src/network.rs`, `tunnel.rs`, `dns_profile.rs`, `worker_job.rs`, `scripts/app-proxy.mjs`, `app-dns.mjs`, `lagom-tunnel.mjs`, `proxy-bridge.mjs` и места настройки/восстановления WebView в `lib.rs` и `multi_app.rs`.

Продукт в этой части аудита не изменялся. Пользовательский Relay не запускался и не останавливался. Системные DNS, proxy, routes, VPN и Lagom не изменялись. Личные enrollment, профили и ключи не читались. Все сокеты воспроизведения были собственными loopback fixtures на свободных портах; тестовые данные не содержали аккаунтов.

Среда: Windows x64, Node 24.19.0, текущий Cargo lockfile. Программа и package metadata на момент проверки — 1.2.6. Вывод тестов и reproducer сохранены в собственном task work; таблица ниже содержит результат непосредственно, поэтому для оценки не требуется доступ к runtime другого агента.

## Свежие результаты

| Проверка | Результат | Что проверяет |
|---|---:|---|
| Node: `app-dns.test.mjs`, `lagom-tunnel.test.mjs`, `regression/app-proxy.test.mjs`, `regression/proxy-bridge.test.mjs` | 100/100, 0 skipped, 14.98 с | SOCKS framing, приватные адреса, loopback-only, DNS TLS/TTL/cache/rotation/abort, frozen upstream, отсутствие direct fallback, MTProto ordinary/media/test DC, пределы подключения, half-close, 16 MiB backpressure, shutdown |
| Rust: `cargo test --lib --locked network::tests` | 8/8 | Реальное Windows владение listener, чужие IPv4/IPv6 listeners, health identity, backoff, descendants |
| Rust: `cargo test --lib --locked tunnel::` | 25/25 | Конфигурация, DPAPI, bounded plaintext buffer, snapshot/fail-closed, приоритет helper ниже обычного |
| Rust: `cargo test --lib --locked dns_profile::` | 13/13 | Envelope, URL, DPAPI corruption/wrong entropy, отсутствие fallback при повреждении персонального профиля |
| Собственный source-factory loopback reproducer NET-01 | Дефект подтверждён | Первый A-record отказал; второй пригоден, но не был опробован |
| Собственный source-factory loopback reproducer NET-03 | Дефект подтверждён | Ошибка DNS запроса скрыта в health: `dns.state=ready` |
| Проверка порядка monitor NET-02 | Путь подтверждён исходником | Snapshot PID сделан после возможной замены proxy через Telegram recovery |

Итого штатные проверки: 100 Node + 46 Rust прошли. Это не означает отсутствие дефектов: существующий набор не покрывал перечисленные ниже отказные сценарии. Реальные аккаунты, sleep/resume Windows, переключение Wi-Fi, удалённый отказ VLESS и внешний трафик X/Instagram в этой части аудита не воспроизводились.

## Подтверждённые дефекты и план

### NET-01 — P1: единственный плохой A-record ломает загрузку домена

Источник: `scripts/app-proxy.mjs:215` (`destination = addresses[0]`), обработка upstream errors и SOCKS refusal в том же файле. `app-dns.mjs` способен возвращать до восьми пригодных публичных IPv4, но gateway использует только первый.

Триггер: DNS возвращает несколько A-records, первый недоступен через текущий tunnel/DPI route, следующий доступен. Такая ситуация возможна при CDN rotation, частичном сетевом отказе и разных маршрутах к адресам одного домена.

Воспроизведение на настоящем `createAppProxy` с loopback SOCKS backend: mock DNS вернул `[1.1.1.1, 8.8.8.8]`; backend для первого возвратил SOCKS REP 5, для второго способен возвратить REP 0. Клиент получил REP 5. Backend увидел только `1.1.1.1`. При перестановке того же набора на `[8.8.8.8, 1.1.1.1]` тот же клиентский путь успешно получил REP 0. Наружу эти IP не подключались: решение принимал fixture backend.

Исправление: последовательно пробовать ограниченный набор проверенных адресов в пределах единого handshake deadline, через тот же owned backend, с новым upstream socket на попытку. После успешного SOCKS CONNECT и передачи прикладных байтов повторные подключения/повтор запроса запрещены. Не вводить direct fallback, другой DNS, hostname-forwarding или приватные адреса. Добавить проверку отказ первого → успех второго; все адреса отказали; deadline; cancel; отказ после established без replay.

Ограничение вывода: не доказывает, что именно это вызвало Shorts ошибку у другого пользователя.

### NET-02 — P2: monitor пропускает reload социальных WebView после восстановления через Telegram

Источник: `tauri/src/network.rs:174`, `:180`, `:190`; зависимость `ensure_proxy_bridge_running_inner → ensure_dpi_proxy_running_inner → ensure_app_proxy_running`.

Триггер: APP_PROXY или общий backend упал, Telegram bridge использует managed SOCKS route и его recovery выполняется первым. `ensure_proxy_bridge_running` восстанавливает APP_PROXY. После этого monitor читает `previous_dpi_process_id`, который уже равен PID нового proxy. Повторное `ensure_dpi_proxy_running` возвращает тот же PID. `should_recover_service_views(previous,current)` видит равенство и не вызывает reload X/Instagram. На следующем tick оба PID снова равны. Уже загруженная ошибка WebView может остаться на экране, хотя собственные сервисы восстановлены.

Доказательство: проверен реальный порядок выражений и условие `previous_process_id != Some(process_id)`; root APP_PROXY snapshot находится после `ensure_proxy_bridge_running`. Native crash/reload на аккаунтном профиле не выполнялся; наличие ошибочного порядка достоверно, конкретный экран после него зависит от поведения сайта/WebView.

Исправление: снимать предыдущий общий proxy PID до любого recovery в iteration и сравнивать после завершения обоих путей. Обновление социальных WebView выполнять ровно один раз на замену proxy, используя существующую atomic deduplication. Добавить regression case, в котором proxy заменяется внутри Telegram recovery; отдельно проверить обычный tick без замен и одновременно обрабатываемый reconnect.

### NET-03 — P2: диагностика теряет фактические ошибки DNS

Источник: `scripts/app-proxy.mjs:54–65`, `scripts/app-dns.mjs:123`, `:135`, `tauri/src/network.rs:857`.

Триггер: resolver однажды создан, последующие `resolve(host)` завершаются transport/DNS ошибкой. `app-dns` сохраняет `lastQueryState=failed`, но `dnsSummary` передаёт только факт существования resolver и заменяет это на `state=ready`. Rust NetworkStatus видит `dns=ready`.

Воспроизведение: injected source-factory resolver возвратил `APP_DNS_TIMEOUT` для домена; клиент получил SOCKS REP 4; HTTP `/health` в тот же момент сообщил `dns.state=ready`, поле `lastQueryState` отсутствовало. Существующий app-dns fixture также подтверждает `lastQueryState=failed` при собственном `state=ready`, что правильно различает lifetime и исход последнего запроса; gateway это различие теряет.

Исправление: сохранить отдельные sanitized поля состояния lifetime и последней операции/тип статической ошибки, затем показать их в диагностике. Отказ одного внешнего домена не должен автоматически перезапускать общие сервисы и рвать здоровые Telegram sessions; управлять restart нужно по owned local-process/liveness probes. Ни hostname, ни provider path/token в health добавлять нельзя.

Ограничение: `/health` сейчас является проверкой локального процесса, а не доступности Интернета. `dpi_proxy=ready` корректен в этом узком смысле; статус DNS недостаточен для диагностики пользовательского отказа.

## Дополнительные границы восстановления и изоляции

### NET-04 — P2: блокированный main proxy URL не восстанавливается в том же запуске

Источник: `tauri/src/lib.rs:478–493`, `multi_app.rs:104–132`.

При startup conflict на owned front port `can_use_managed_dpi_route()` возвращает false, main WebView создаётся с `http://127.0.0.1:0`. Это безопасно блокирует внешний трафик, однако proxy URL зафиксирован в builder. После освобождения порта monitor может восстановить сеть и показать local ready; функция reload пересозданный proxy не назначает main и обрабатывает только X/Instagram. Для main нужен новый запуск или контролируемое пересоздание WebView с правильным endpoint. Обычная перезагрузка страницы сама по себе proxy URL не меняет.

Подтверждение — прямой путь в исходниках; конфликт штатного пользовательского listener не создавался. Для нового релиза нужно либо иметь стабильный owned front endpoint с fail-closed forwarding и контролируемым восстановлением backend, либо явно сообщать, что обнаруженный startup conflict требует нового запуска после освобождения порта. Проверять в отдельном идентификаторе приложения, не закрывая профиль пользователя.

### NET-05 — P2 относительно требования полного DNS независимого туннеля: hostname самого VLESS сервера использует системный resolver

Источник Relay: `scripts/lagom-tunnel.mjs:48`, `:104`; tunnel validator требует hostname сервера и `sockopt.domainStrategy=AsIs`.

Прочитан поставленный первичный source archive Xray commit `47cfe9994a6b39b1f673ba35e62b091bcce15a71`: `transport/internet/splithttp/dialer.go:121` вызывает `internet.DialSystem`; `transport/internet/dialer.go:251` применяет собственный DNS client только при `DomainStrategy.HasStrategy()`; `transport/internet/system_dialer.go:117–144` передаёт hostname в Go `net.Dialer.DialContext`. `AsIs` не выбирает собственный DNS strategy.

В аудите дополнительно проверено, что `runtime/xray.exe` совпадает по SHA256 с бинарником рядом с source archive: `8965A30C44CE8F2DF4CC5AA5DEAC790C767066C31A1FFC218D49923862F3F55C`. Старые результаты engine tests не засчитаны как свежие тесты.

Прикладные домены проходят selected DoH внутри owned backend, но hostname outer endpoint туннеля сначала должен разрешиться средствами ОС. Неправильный или недоступный системный DNS/Lagom resolver может помешать старту самого туннеля. Это не запись системных настроек и не доказанная утечка содержимого запросов приложения; это конкретная bootstrap dependency. Packet capture не проводился.

Вариант доработки: определить и документировать отдельный encrypted endpoint bootstrap без круговой зависимости от ещё не созданного туннеля; IP pinning должен сохранять исходные SNI/Reality identity и TLS проверку, иметь bounded refresh и отказ без скрытого plaintext DNS fallback. Нельзя обещать полную независимость от системного resolver в текущей модели.

### Crash ownership имеет разную строгость в network sidecars и media workers

`WorkerJob::attach` возвращает ошибку при отказе создания/настройки/assignment Windows job. `network::assign_to_job` (`network.rs:1231+`) только записывает предупреждение и допускает запуск sidecar. Нормальный shutdown имеет owned PID cleanup, но crash-cleanup гарантия при неуспешном Job assignment ослаблена. В этой среде ошибку job API не воспроизводили; это условная граница, не наблюдавшаяся авария. Для формальной crash-cleanup гарантии network ownership должен стать обязательным gate с остановкой собственноручно запущенного child при ошибке.

## Что уже защищено текущей реализацией

- Network startup и restart сериализованы одним mutex; cleanup помечает stopping до остановки дочерних процессов.
- Front gateway и backend bind только на `127.0.0.1`, ports валидируются и не могут совпадать. Windows listener ownership проверяется; чужой сервис не принимается как здоровый собственный proxy.
- Domain targets проходят валидацию, selected DoH, public IPv4 guard и pinned numerical SOCKS request; приватные/loopback/link-local/multicast/IPv6 targets, произвольные порты и UDP/BIND отказаны.
- Application DoH соединения сами проходят через тот же local backend; TLS hostname/certificate validation включены; provider token не передаётся argv или health. Ротация provider IP имеет bounded cooldown.
- Tunnel envelope ограничивает конфигурацию единственным loopback SOCKS inbound и единственным VLESS outbound; нет direct outbound или tun, изменения маршрутов ОС не выполняются.
- Personal profiles защищены DPAPI; corruption и неверная entropy дают ошибку, не переводят приложение на public/direct route. Snapshot удерживает выбранный профиль для процесса.
- WebView SOCKS arguments отключают QUIC и non-proxied UDP WebRTC, запрещают обычное внешнее разрешение имён. Есть явный локальный bypass для Tauri origins и loopback bridge.
- Recovery debounce и exponential retry ограничены, helper startup Windows priority ниже normal, workers имеют размерные/временные пределы.

Эти утверждения относятся к рассмотренным source paths и перечисленным свежим тестам. Они не являются packet-level доказательством отсутствия любого внешнего трафика всей программы, updater и всех вспомогательных функций.

## Рекомендуемые gates для 1.3.0

1. Устранить NET-01 и NET-02; сохранить fail-closed и запрет replay после успешного CONNECT.
2. Передать диагностику NET-03 до пользовательского экрана состояния; не использовать единичные remote ошибки как restart trigger.
3. Уточнить восстановление main route после startup port conflict (NET-04) и bootstrap contract туннеля (NET-05).
4. В отдельном app identifier с синтетическим профилем выполнить owned sidecar crash → recovery, backend crash, frontend port conflict → release, зависание backend, resume after sleep и два параллельных reconnect. Проверить отсутствие sidecar orphan, foreign-process termination, повторного HTTP payload и одновременного reload.
5. Отдельно проверить actual X/Instagram и exact failing Shorts при наличии безопасного тестового аккаунта/ссылки и конкретной сети. Unit success не заменяет эти данные.

Вердикт сетевой части: базовая изоляция приложения от изменений системной сети реализована, штатные тесты проходят. Два отказных сценария воспроизведены, один recovery defect подтверждён кодовым путём. Полная стабильность при любых VPN/провайдерах, внешний route availability, sleep/resume и независимость outer DNS bootstrap пока не доказаны.

## Реализация 1.3.0

Финальная проверка после изменений и переноса implicit bridge port: полный сетевой Node набор **113/113**, 0 skipped, 16.06 с; targeted Rust `network::tests` **14/14**, сборка текущей версии 1.3.0 без предупреждений. Node набор получил 11 новых proxy checks и 2 source-contract checks передачи bridge port; Rust network — 6 новых checks. Общая проверка всех native/media/UI функций и упаковки относится к root release gate, а не к этому targeted результату.

### NET-01

Gateway получает выбранный DNS результат один раз, проверяет весь набор адресов, удаляет повторы и пробует до восьми публичных IPv4 через тот же frozen owned backend. Общий handshake deadline — 15 секунд с учётом DNS и клиентского handshake; если есть следующий адрес, текущей попытке выделяется до 4 секунд. Единственный адрес и последняя попытка сохраняют весь оставшийся бюджет. Backend policy denial и malformed SOCKS protocol завершают запрос. При успешном CONNECT начинается established stream, и потеря соединения закрывает его без нового подключения или replay прикладного запроса.

Идентичность socket проверяется в callback каждого attempt, поэтому поздний close/error/data от предыдущего уничтоженного socket не повреждает следующую попытку. При cancel, shutdown и failure очищаются оба timer; client early payload остаётся только в gateway до успешного CONNECT и отправляется один раз.

До правки meaningful regression subset имел 3 failures из 5: первый отказ → второй успех; отказ всех уникальных адресов; degraded DNS. Policy denial и established no-replay уже проходили. Новые проверки после реализации включают exact byte preservation, предел восьми попыток, единственный provider/backend, stalled address, total deadline, cancel и отсутствие established replay.

### NET-02

Monitor снимает previous APP_PROXY PID до чтения network status и до любого nested Telegram/DPI recovery. Замена proxy через Telegram dependency теперь входит в сравнение before/after. Existing atomic dedup не допускает повторного reload того же PID при manual/monitor recovery. Unit case проверяет changed PID, повтор того же PID, исчезновение proxy и последующее появление.

### NET-03

Loopback health передаёт только enum `lastQueryState = unqueried | succeeded | failed`. `dns.state=degraded` означает живой resolver с отказом последнего запроса; успешный следующий запрос возвращает `ready`. Произвольный текст mock/provider summary не сериализуется. Rust NetworkStatus сохраняет `degraded`; local service liveness и restarter это поле не используют, поэтому отказ DNS не запускает общую restart петлю и не прерывает здоровые numeric Telegram sessions.

### NET-04

Effective bridge/front/backend ports выбираются до main WebView и сохранены одним `OnceLock` на весь процесс. Только неявные default ports при чужом loopback/wildcard/IPv6 listener, недоступном default bind или совпадении с портом другой службы могут получить свободный ephemeral port. Системные environment variables не меняются. Явно заданные `EGOIST_RELAY_BRIDGE_PORT`, `EGOIST_RELAY_DPI_PORT` и `EGOIST_RELAY_DPI_BACKEND_PORT` сохраняются: чужой listener должен завершиться owned startup error, а две явно заданные внутренние коллизии — ошибкой конфигурации. Если explicit front/backend совпадает с implicit default bridge, меняется только implicit bridge.

При выборе исключены зарезервированный legacy Telegram port, все explicit service ports и уже выбранные другие сервисы; tunnel inbound materialize получает effective backend port. Legacy MTProxy port сохраняет прежнее значение для отдельно заданного MTProxy route. Обычный managed Telegram route использует effective front SOCKS port. Reservation закрывается до запуска helper. Между закрытием reservation и bind остаётся race: если выбранный порт займёт чужой процесс, helper обязан не стать ready, существующий Windows PID ownership gate запрещает принятие чужого listener. Новый порт после старта WebView не выбирается, чтобы не рассинхронизировать network clients.

Frontend уже имел контракт динамического порта: `connector.ts:164–175` ждёт ready network status, сохраняет `bridgePort`; `:113–116` передаёт его в `Worker.name` как `relayProxyPort`. `PromisedWebSockets.ts:195–209` проверяет целочисленный диапазон и выбирает этот loopback endpoint прежде fallback 17884. Native startup и NetworkStatus теперь используют одну `configured_bridge_port()`. Новый `regression/bridge-port-contract.test.mjs` выполняет оба настоящих TS модуля с mock invoke/Worker: недоступный → ready статус с нестандартным портом, ожидание перед запуском worker, URL с выбранным портом и сохранение dc/test/premium/media parameters. Отдельно проверены недопустимые worker ports и прежний fallback. Продуктовый frontend не менялся.

При выборе root main blocked URL вызывается `network::mark_main_proxy_blocked`; `NetworkStatus.mainRouteRequiresRestart=true` сохраняется весь запуск. В этом состоянии восстановление sidecar не объявляет восстановленным сам main WebView proxy route. Пересоздание аккаунтного WebView и принятие чужого listener не выполняются.

Native selection unit cases используют только собственные занятые loopback/wildcard/IPv6 sockets и проверяют implicit alternate сразу трёх сервисов, explicit preserved, различие service ports, сохранность исходного listener, implicit/explicit collision и отказ explicit collision/порта 0. Полный native sidecar install/run с occupied default и actual WebView остаётся отдельной интеграционной проверкой root release gate. Source-contract test требует `EGOIST_RELAY_AUDIT_WORK` или `EGOIST_RELAY_TEST_WORK` с абсолютным путём собственного временного test work; сгенерированные mock bundles не записываются в проект или общий runtime.

NET-05 и условный отказ Windows Job assignment не менялись. Сервер владельца, его DNS и Lagom не изменялись.

## Xray: повторная оценка четырёх Go warnings

Проверка выполнена 30 сентября 2026, Москва, только для принятого engine package `releaseengine-source/xray-47cfe999-go1.26.8` и `runtime/xray-provenance.json`. Личные профили не читались; Xray, его исходники и runtime не изменялись. В каталоге host toolchains и в `Get-Command go,govulncheck` Go SDK/scanner отсутствуют. Новый govulncheck не запускался, инструменты не устанавливались. Ниже — свежая сверка четырёх первичных Go advisory и integrity/source review, а не новый полный vulnerability scan.

Точная идентичность: Xray commit `47cfe9994a6b39b1f673ba35e62b091bcce15a71`, build label `47cfe999-relay-go1.26.8`, Windows amd64, CGO disabled. SHA256 текущего `runtime/xray.exe` и принятого source-package бинарника совпадают: `8965a30c44ce8f2df4cc5aa5deac790c767066c31a1ffc218d49923862f3f55c`. Source ZIP SHA256 совпал с manifest: `e13eaf674c6f6ec25e2ebd18864bf0c0428a91235eb77b52b47a44dbc281db58`. Archive содержит CRLF в go.mod/go.sum; после CRLF→LF их hashes точно совпадают с source hashes manifest. Это различие окончания строк, без различий lockfile content.

| Advisory и точная область | Версия в engine | Условия и vendor remediation | Применимость к этому binary |
|---|---|---|---|
| [GO-2026-5841](https://pkg.go.dev/vuln/GO-2026-5841), `github.com/klauspost/compress/s2.NewDict`; опубликован/обновлён 27 июля 2026 | compress v1.17.4, входит в affected range v1.16.0…<v1.18.7 | Специально сформированный dictionary при S2 encoding может вызвать чтение вне границ. Исправление: compress ≥v1.18.7. | Module warning применим по версии. Accepted `go list -deps ./main` inventory не содержит `compress/s2`, source scan не имеет package/symbol trace. Включённые zstd/fse/huff0 не являются пакетом S2, указанным в advisory. Достижимый уязвимый путь не подтверждён. |
| [GO-2026-5932](https://pkg.go.dev/vuln/GO-2026-5932), `golang.org/x/crypto/openpgp` и подчинённые пакеты; опубликован/обновлён 7 июля 2026 | x/crypto v0.55.0; advisory относится ко всем версиям OpenPGP | Пакет не поддерживается и имеет известные проблемы. Fixed version нет; если функция нужна, vendor рекомендует поддерживаемую замену OpenPGP. Простое обновление x/crypto этот warning не убирает. | Все семь affected OpenPGP package paths отсутствуют в accepted compiled-import inventory; package/symbol traces отсутствуют. Достижимый уязвимый путь не подтверждён. |
| [GO-2026-6354 / CVE-2026-78662](https://pkg.go.dev/vuln/GO-2026-6354), `golang.org/x/crypto/ssh`; опубликован/обновлён 2 сентября 2026 | x/crypto v0.55.0 < fixed v0.56.0 | Malicious SSH peer может заблокировать соединение пакетами ещё не установленного канала. Advisory перечисляет SSH Dial/NewClientConn/NewControlClientConn/NewServerConn и channel methods. Исправление: x/crypto ≥v0.56.0. | SSH отсутствует в accepted compiled-import inventory и source package/symbol traces. Достижимый SSH путь в этом engine не подтверждён. |
| [GO-2026-6355 / CVE-2026-56855](https://pkg.go.dev/vuln/GO-2026-6355), `golang.org/x/crypto/ssh`; опубликован/обновлён 2 сентября 2026 | x/crypto v0.55.0 < fixed v0.56.0 | Malicious SSH peer может заблокировать уже установленный канал. Исправление: x/crypto ≥v0.56.0. | Та же граница: affected SSH package отсутствует в accepted inventory, source package/symbol traces отсутствуют; достижимый путь не подтверждён. |

Все четыре текущих JSON records получены непосредственно с `vuln.go.dev/ID/<id>.json` в собственный audit work. Они полностью совпали с OSV records внутри принятого source scan от 28 сентября; modification dates не изменились. Это проверка содержания конкретных advisory, не доказательство отсутствия других или новых vulnerabilities. [Go release history](https://go.dev/doc/devel/release#go1.26.8) подтверждает Go 1.26.8 от 1 сентября 2026; перечисленные четыре warnings относятся к сторонним модулям, а не к версии standard library. Отдельный свежий scan всей Go standard library не выполнен.

Проверена integrity принятого evidence: `dependency-inventory.json`, `dependencies.json`, `govulncheck-source.json` и `govulncheck-binary.json` совпадают с hashes manifest. В inventory 729 compiled-import package paths; проверки всех affected paths выше дали отсутствие. Это evidence прежней сборки, заново `go list` не выполнялся. Дополнительно прочитаны все 929 Go-файлов текущего принятого source ZIP: прямых imports S2, SSH и OpenPGP нет. Этот свежий прямой поиск сам по себе не заменяет анализ транзитивных dependencies или compiler call graph.

Почему binary scan содержит имена функций: принятый `scanner-extract-summary.json` сообщает `pkgSymbolsCount=0`. Этот вспомогательный summary не включён в hashed manifest, поэтому его содержимое не принимается за независимое свежее извлечение символов. Однако первичный [govulncheck v1.8.0 binary.go](https://github.com/golang/vuln/blob/v1.8.0/internal/vulncheck/binary.go#L105-L114), заново прочитанный с upstream, подтверждает алгоритм: при пустых extracted symbols scanner использует `allKnownVulnerableSymbols` для модулей. Поэтому 39 binary finding records с названиями функций не доказывают, что эти функции скомпилированы и достижимы. Принятый source scan содержит четыре module-only finding records и ноль package/symbol traces.

**Решение для gate:** по этим четырём предупреждениям не выявлен подтверждённый достижимый уязвимый путь в точном frozen binary; оснований для срочной неподтверждённой замены tunnel engine нет. Module warnings сохраняются, заключение «нулевые уязвимости» недопустимо. Полная свежая проверка source/binary и transitive compiled-import graph остаётся открытой из-за отсутствия scoped Go SDK/scanner. Для следующего контролируемого engine update: поддерживаемый Xray source, compress ≥v1.18.7 и x/crypto ≥v0.56.0, отдельные fresh scans и повтор exact-profile/interop/stall/installer gates. OpenPGP warning оценивать по package presence, поскольку fixed x/crypto version для него не существует. Exploit или attack traffic не запускались; сведения об эксплуатации в реальных инцидентах в этой ограниченной проверке не исследовались.
