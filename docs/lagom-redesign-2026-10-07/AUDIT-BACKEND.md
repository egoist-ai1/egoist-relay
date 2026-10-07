# Backend-аудит Egoist Relay 1.6.1 «как есть»

Дата: 2026-10-07. Режим: только чтение. Исходники не менялись, приложение не запускалось и не собиралось, `.env` и auth-файлы не открывались.
Корень проекта: `C:\Users\Egoist\Desktop\Проекты\Приложения\Egoist Relay`. Пути ниже даны от корня проекта.

## 0. Метод и обозначения

Основной проход (Rust, Tauri-конфигурация, capabilities, research-мост, установщик, CI) выполнен мной построчно. Два параллельных прохода покрыли Node-скрипты и релизный контур (префикс `JS-`) и клиентский API-слой GramJS (префикс `CL-`). Из их отчётов я перечитал по коду то, что вошло в P1, и часть P2. Остальное передано как есть и помечено «проход-2».

Нумерация: `RS-` — Rust/Tauri/установка (мой проход), `JS-nn` соответствует `R-nn` из отчёта прохода по Node-скриптам и релизу, кроме `JS-11` (= его `R-14`); его `R-11` (мост исследований) вошла в `RS-08`. `CL-` — клиентский слой.

Статусы утверждений:

- **[проверено]** — подтверждено чтением кода или командой (`git`, `sha256sum`, `diff`).
- **[наблюдение]** — факт из кода, оценка риска моя.
- **[гипотеза]** — вывод из кода, в рантайме не воспроизводился.
- **[не проверено]** — не смотрел или нельзя без запуска.

Шкала: **P0** — удалённая эксплуатация или потеря учётных данных без действий пользователя; **P1** — подтверждённый дефект с потерей данных или молчаливым отказом, либо дыра в границе доверия; **P2** — реальный риск или заметная деградация; **P3** — гигиена и мелочи. Трудоёмкость: S — до полудня, M — 1–3 дня, L — больше.

Решения владельца из `AGENTS.md` («Границы безопасности Tauri») я не считаю багами: широкая CSP, `withGlobalTauri`, `shell:default`/`core:window:allow-destroy` для UUID-окон, фича `devtools`, закреплённые версии с вендорным патчем. Они прокомментированы отдельно в разделе 3.1.

## 1. Резюме

P0 нет. Остановить релиз я бы не стал, но три пункта стоит закрыть до следующей версии.

| # | Находка | Приоритет |
|---|---|---|
| RS-01 | Команда `relay_inline_save_media` не внесена в `AppManifest` — любой вызов из UI отклоняется ACL. Кнопка «сохранить оригинал» у встроенных превью не работает в сборке | P1 |
| RS-02 | Загрузки из Mini App и их popup-окон идут в тот же нативный конвейер, что и загрузки Telegram: файл любого расширения и размера молча попадает в `Downloads`, без подтверждения; очередь на 64 записи забивается | P1 |
| JS-01 | Репозиторий не воспроизводит сборку: `scripts/`, `runtime/`, `tauri/installer*`, 15 из 22 файлов `tauri/src` не под git; один коммит; `dist/` отслеживается | P1 |
| CL-01…04 | Клиент: сбой отправки альбома, вложения и не-RPC ошибки оставляют сообщение «отправляется» навсегда; один сбой `getDifference` отключает восстановление пропусков | P1 |

Что хорошо: загрузки и журнал операций (атомарная замена с write-through, DPAPI, приватный DACL), URL-allowlist медиа-воркеров, Job Object для всех дочерних процессов, мост исследований с взаимной HMAC-аутентификацией, ACL-проверка приватного каталога, чёткое разделение capabilities по меткам. Подробнее — раздел 9.

Счётчики реестра: P0 — 0, P1 — 7 (RS-01, RS-02, JS-01, CL-01…CL-04), P2 — 32, P3 — 55 (всего 94).

## 2. Архитектура

### 2.1 Карта модулей Rust (`tauri/src`, 16 745 строк)

| Файл | Строк | Роль | Тестов |
|---|---|---|---|
| `lib.rs` | 597 | Сборка приложения, плагины, единственный экземпляр, главное окно, `invoke_handler` (49 команд) | 2 |
| `multi_app.rs` | 1794 | Дочерние WebView X и Instagram поверх главного окна, наблюдатели WebView2 (навигация, готовность, падение процесса), watchdog загрузки 45 с, allowlist доменов, popup входа | 0 |
| `multi_app_downloads.rs` | 847 | Подключаемый модуль `multi_app` (`#[path]`). Нативные загрузки WebView2: подготовка, staging, публикация без замены, отмена | 13 |
| `media_operations.rs` | 3321 | Журнал операций (DPAPI-файл), машина состояний, команды UI, открытие файла | 28 |
| `inline_media.rs` | 1141 | Резолвер публичных видео: Node-воркер + yt-dlp + ffmpeg, `OwnedDirectory`, cookie из дочернего WebView | 11 |
| `social_share.rs` | 950 | Приём запроса «поделиться» от enhancer-скриптов, `fetch` медиа в Node-воркере, очередь detached | 7 |
| `research_bridge.rs` | 1771 | Родитель Node-помощника с named pipe; валидация потока событий (`validate_event`), реестр запросов | 15 |
| `research_social.rs` | 2978 | Скрытые окна X/Instagram для чтения по запросу MCP, проверка владельца ответа (nonce, URL, эпоха аккаунта) | 11 |
| `system_proxy.rs` | 714 | Чтение системного прокси и PAC через WinHTTP (асинхронно, с отменой) | 22 |
| `telegram_transport.rs` | 219 | Супервизор Node-моста WebSocket на loopback для GramJS | 0 |
| `transcription.rs` | 471 | whisper-cli, один задание за раз, 64 МиБ / 30 мин | 0 |
| `bot_web_apps.rs` | 391 | Mini App как дочерние WebView2, мост `chrome.webview.postMessage` | 3 |
| `installer.rs` | 353 | Остаток собственного установщика: команды зарегистрированы, но ни в одной capability не выданы | 0 |
| `youtube_player.rs` | 122 | Подстановка `Referer` для embed YouTube | 2 |
| `tray/mod.rs`, `tray/badge.rs` | 188 + 263 | Трей, счётчик на иконке | 0 |
| `worker_job.rs` | 95 | Job Object (`KILL_ON_JOB_CLOSE`) для дочерних процессов | 0 |
| `runtime.rs`, `deeplink.rs`, `window.rs`, `main.rs` | 61 + 50 + 13 + 6 | Поиск `node.exe`, `tg://`, состояния окон | 0 |
| `mac.rs` | 400 | Только macOS, в Windows-сборке не участвует | 0 |

Сборка (`tauri/build.rs`) запускает `runtime/node.exe scripts/build-telegram-transport.mjs` и вшивает результат (`telegram-transport.cjs`) через `include_str!(OUT_DIR)`. `include_str!` подтягивает ещё `scripts/inline-media-resolver.mjs`, `social-media-fetch.mjs`, `media-proxy.mjs`, `instagram-enhancer.js`, `x-enhancer.js`, `social-share-enhancer.js`, `mini-app-bridge.js`, `runtime/research/social-read.js`.

### 2.2 Процессы, окна и WebView

| Сущность | Метка | Источник контента | IPC |
|---|---|---|---|
| Главное окно, WebView Telegram Web A | `main` | локальный `http://tauri.localhost` | да, 7 capabilities |
| X | `x_webview` (child `main`) | `https://x.com` | нет |
| Instagram | `instagram_webview` (child `main`) | `https://www.instagram.com` | нет |
| Окна входа | `x-auth-N`, `instagram-auth-N` | домены X/Meta | нет |
| Исследование X/IG | окно `relay-research-window-*`, WebView `relay-research-x`, `relay-research-instagram` | первые стороны | только `relay_research_social_reply` по remote URL |
| Mini App | `mini-app-<uuid>` (child `main`) | произвольный `https` | нет |
| Popup Mini App | `mini-app-popup-<uuid>` | произвольный `https` | нет |

Окон с чистой UUID-меткой, которой соответствует шаблон `????????-????-????-????-????????????` в `default.json:5`, приложение сейчас не создаёт. Шаблон — остаток старой модели «окно на чат». `relay_control_status` считает такие окна в поле `legacyTelegramWindowCount` (`lib.rs:147`).

Дочерние процессы: `node.exe` (резолвер, `social-media-fetch`, транспорт Telegram, мост исследований), `yt-dlp.exe`, `ffmpeg.exe`/`ffprobe.exe` (через резолвер), `whisper-cli.exe`, `powershell.exe` (только в установщике и в `ensure-private-state.ps1`). Все, кроме помощника исследований, приписываются к Job Object с `KILL_ON_JOB_CLOSE` (`worker_job.rs:45`), поэтому умирают вместе с приложением. Помощник исследований завершается по EOF на `stdin` (`research_bridge.rs:921-932`).

### 2.3 Потоки данных и границы доверия

```
Telegram-сервер ⇄ GramJS (Worker в main WebView) ⇄ ws://127.0.0.1:<порт>/apiws?token  ⇄ Node-мост (telegram-transport.cjs) ⇄ Lagom MTProxy
                                   │
main WebView (Teact UI, доверенный код, tauri:// / tauri.localhost)
   │ invoke / listen (ACL по меткам + local:true)
   ▼
Rust ── Command/Job Object ──► node.exe ──► yt-dlp / ffmpeg ──► CDN YouTube/IG/X (через SOCKS-шлюз с allowlist)
   │                           └─► whisper-cli.exe (локально)
   ├─ WebView2 x_webview/instagram_webview (недоверенный сторонний JS + init-скрипты Relay)
   ├─ WebView2 mini-app-* (произвольный https; мост postMessage с nonce)
   ├─ journal-v1.dpapi (профиль пользователя, DPAPI + приватный DACL)
   ├─ Downloads\.egoist-relay-media\job-*  (staging) → Downloads\<имя>
   └─ stdin/stdout ──► node bridge-server.mjs ── \\.\pipe\EgoistRelayAccountBridge-… (HMAC) ◄── внешний Social MCP
```

Границы:

1. **WebView ↔ Rust.** Единственная граница — ACL Tauri: `AppManifest::commands` (`build.rs:49-98`) + 7 capabilities. Каждая команда с побочным эффектом, кроме группы из `default.json`, дополнительно вызывает `require_main` (`social_share.rs:307-319`, свой вариант `trusted_main` в `research_bridge.rs:190-205`, свой `require_main` в `transcription.rs:69-81`). Источник ACL — URL фрейма отправителя (`tauri/vendor/tauri/src/webview/mod.rs:2012`), поэтому iframe с чужим origin получает `Origin::Remote`.
2. **Rust ↔ внешний процесс.** stdin с JSON (URL, пути), строгие коды `MEDIA_*` на stderr/exit code, таймауты, лимиты вывода, Job Object.
3. **Rust ↔ сеть.** Сам Rust сеть не открывает. Исключение — WinHTTP для разрешения прокси. Весь сетевой код живёт в Node-воркерах и WebView2.
4. **Rust ↔ диск.** Профили WebView2 в `%LOCALAPPDATA%\com.egoist.relay\{x,instagram,mini-apps,media-operations}`, кэш `public-media`, `transcription`, `Downloads\.egoist-relay-media`, `%USERPROFILE%\.egoist-research` (мост).
5. **Внешний процесс ↔ Rust.** Мост исследований принимает запросы с named pipe от любого процесса пользователя, знающего токен. Это публичный интерфейс «агент → аккаунты Telegram/X/Instagram».
6. **Сторонний JS ↔ скрипты Relay.** `instagram-enhancer.js`, `x-enhancer.js`, `social-share-enhancer.js`, `social-read.js` исполняются в **главном мире** страницы X/IG и делят его с кодом сайта (разбор в 3.3).

### 2.4 Команды Tauri (49 в `invoke_handler`, `lib.rs:301-351`) и их capability

| Capability (файл) | webviews / URL | Команды |
|---|---|---|
| `default.json` (`local:true`) | `main` и шаблон UUID | `mark_title_bar_overlay`, `set_notifications_count`, `set_window_title`, `open_new_window_cmd`, `save_current_url`, `set_menu_translations`, `relay_control_status`, `relay_get_telegram_transport`, `multi_set_active_app`, `multi_prewarm_x`, `multi_prewarm_instagram`, `multi_update_x_bounds`, `multi_x_navigate`, `multi_instagram_navigate`, `multi_open_external` + плагины: `core:event:default`, часть `core:window:*`, `process:default`, `notification:*` (3), `shell:default` |
| `bot-web-apps.json` | `main` | `relay_mini_app_open/update/reload/send/close` |
| `local-media.json` | `main` | `relay_inline_resolve_media`, `relay_inline_cancel_media`, `transcribe_voice`, `cancel_voice_transcription` |
| `media-operations.json` | `main` | `relay_media_operations_list`, `relay_media_operation_action`, `relay_media_operation_revision`, `relay_media_download_prepare`, `relay_media_download_file_name`, `relay_media_operation_source`, `multi_set_content_visible`, `multi_social_detach/release/restore` |
| `social-share.json` | `main` | `multi_social_overlay`, `_cancel_media`, `_read_media`, `_set_labels`, `_save_media` |
| `research-main.json` | `main` | `relay_research_ready`, `relay_research_reply` |
| `research-social.json` (`local:false`) | `relay-research-x`, `relay-research-instagram` + `remote.urls` x.com, twitter.com, instagram.com | `relay_research_social_reply` |
| нет | — | `relay_inline_save_media` (**заблокирована**, RS-01), `installer::*` — 6 команд, недостижимы |

Проверка соответствия `generate_handler!` ↔ `AppManifest::commands`: в handler 49 команд, в манифесте 48. Недостаёт `relay_inline_save_media` [проверено]. Два файла в `tauri/permissions/autogenerated/` (`relay_get_network_status.toml`, `relay_reconnect_network.toml`) относятся к командам, которых уже нет [проверено].

События Rust → UI (`emit_to("main", …)`): `multi-x-status`, `multi-instagram-status`, `relay-media-operation`, `relay-media-source`, `download-finished`, `relay-media-download-started`, `relay-media-toggle`, `relay-transcription-progress`, `multi-social-share`, `multi-social-share-error`, `multi-social-media-progress`, `relay-mini-app-event`, `relay-research-request`, `relay-research-cancel`, `deeplink`. UI → Rust: событие `relay-media-cancel-download` (рассылка `app.emit` без адресата, `media_operations.rs:894`; слушатель в `multi_app_downloads.rs:367`). Плагины: `single-instance`, `os` (выданных прав нет), `fs` (выданных прав нет, во фронтенде не используется), `shell`, `notification`, `log`, `deep-link`, `process`, `updater` (только при `WITH_UPDATER=true`).

### 2.5 Правила `capabilities/*.json` и `permissions/*.toml` — оценка минимальности

- Новые команды получают отдельные файлы, `local: true`, метка `main` — правило `AGENTS.md` соблюдено для шести из семи файлов [проверено].
- `permissions/bot-web-apps.toml` и `research-bridge.toml` описывают набор по командам, без `scope` — разумно: аргументы проверяются в Rust.
- Для `default.json` (решение владельца) факты: `process:default` включает `allow-exit` и `allow-restart`; `core:event:default` включает `allow-emit` и `allow-emit-to` [проверено по `gen/schemas/acl-manifests.json`]. Ни то ни другое во фронтенде не нужно для UUID-окон, которых не существует. Рекомендация (не баг): оставить в шаблоне UUID только закрытие/показ/перетаскивание окон, `process:default` заменить на `process:allow-restart` (используется `relaunch`), `core:event:default` ограничить `allow-listen`/`allow-unlisten`. Это S-правка в одном JSON.
- `shell:default` = `allow-open` со стандартным regex `^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+`. Параллельно существует `multi_open_external` с жёсткой `validate_remote_url`; оба пути ведут в `ShellExecute`. Полезно оставить один.

## 3. Безопасность

### 3.1 Tauri-конфигурация, CSP, вендорный патч

Факты [проверено]:

- `tauri.conf.json:24-37` — CSP: `connect-src … http: https: ws: wss:`, `frame-src http: https:` + схемы кошельков, `script-src 'self' 'wasm-unsafe-eval' https://t.me/_websync_ …`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `img-src` без `https:`. Это решение владельца. Замечание проход-2: в Tauri `websync` отключён (`src/util/websync.ts`), поэтому три `_websync_` источника не нужны; можно убрать, не меняя поведение (CL-27).
- `withGlobalTauri: true` (строка 4). `freezePrototype` не задан (по умолчанию выключен). Включение блокирует загрязнение прототипов в главном рендерере, но может сломать библиотеки форка; решать после проверки (P3).
- `Cargo.toml:19` — `features = ["devtools", …]`; `Cargo.toml:55` — `panic = "abort"`. Любой `panic!`, `unwrap` на `None` или выход за границы массива в любом потоке завершает процесс и роняет все три сервиса сразу. Решение про `devtools` — владельца; в публичный релиз убрать.
- `[patch.crates-io] tauri = { path = "vendor/tauri" }` (`Cargo.toml:45`). Я сравнил `tauri/vendor/tauri` с `~/.cargo/registry/src/*/tauri-2.12.0` (`diff -rq`): отличается один файл `src/path/init.js` (плюс служебные `Cargo.lock`, `Cargo.toml.orig`). SHA-256 оригинала совпадает с `originalFileSha256` из `tauri/vendor/tauri-provenance.json` [проверено]. Патч — добавление проверки `window.__TAURI_INTERNALS__?.plugins` — безопасен: он только не даёт скрипту упасть во фреймах без плагинной инфраструктуры.
- `minimumWebview2Version: 143.0.0.0`, `installMode: currentUser`, `offlineInstaller`, `createUpdaterArtifacts: false`, updater выключен в CI (`WITH_UPDATER: 'false'`).
- Аргументы WebView2 для X (`multi_app.rs:43-47`): отключены `msWebOOUI`, `msPdfOOUI`, `msSmartScreenProtection` (это дефолт Wry 0.57, повторён явно), включён autoplay без жеста, `--host-resolver-rules="MAP abs.twimg.com ton.twimg.com, MAP pbs.twimg.com ton.twimg.com"`. Последнее хрупко: подмена зависит от того, что три хоста лежат на одних и тех же IP; если CDN разведёт их, картинки перестанут грузиться [наблюдение]. Отключённый SmartScreen в WebView — см. RS-02.

### 3.2 Входящие сообщения и валидация на границе

- Все публичные команды принимают строго типизированные структуры с `deny_unknown_fields` (`media_operations.rs`, `bot_web_apps.rs`, `social_share.rs`) [проверено].
- Идентификаторы — только UUID канонической формы (`validate_request_id`, `label_for_id`, `validate_operation`).
- URL источников — каноникализация из белого списка форм: `canonicalize_media_url` (`inline_media.rs:661-751`) отвергает `%`, `\`, `..`, порты, userinfo, неканоничные пути; для YouTube — ровно один `v=`. `validate_source_url` (`media_operations.rs:1516-1576`) то же для журнала. `canonical()` в `research_social.rs:252-277` подменяет хост на фиксированный и срезает query. Это сильный слой.
- `validate_remote_url` (`multi_app.rs:1325-1350`): https, без userinfo, хост не `localhost/.local/.internal/.lan/home.arpa`, IPv4 публичный, IPv6 не loopback/ULA/link-local, IPv4-mapped проверяется. Пробелы: односоставные имена (`intranet`, `router`), `100.64.0.0/10`, `192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15`, DNS-имена, которые указывают на `127.0.0.1` (`localtest.me`). Для открытия внешним браузером это P3.
- `parse_app_url` для Mini App (`bot_web_apps.rs:41-50`) принимает любой `https`-хост, в том числе приватный и loopback. Обычный браузер делает то же, но Mini App стартует по ссылке от бота; рассматривайте как P3 с учётом политики Private Network Access в WebView2.

### 3.3 Скрипты, инъецируемые в сторонние WebView: модель угроз

Что делают: `x-enhancer.js`, `instagram-enhancer.js`, `social-share-enhancer.js` — UI-надстройки и приём «поделиться»; `social-read.js` — чтение DOM по запросу; `mini-app-bridge.js` — протокол Telegram Web Apps.

Ключевой факт: `AddScriptToExecuteOnDocumentCreated` исполняет скрипт в **том же JS-мире**, что и страница. Всё, что скрипт кладёт в глобальные объекты, видит сайт; всё, что он читает у `window`/прототипов, может быть подменено сайтом.

Каналы к Rust и их защита [проверено кодом, если не указано иное]:

| Канал | Откуда | Защита | Что может сделать злонамеренная страница |
|---|---|---|---|
| `egoist-relay-share://request?token=…&payload=…` через `location.href` (`social-share-enhancer.js:150`) | enhancer | токен на жизнь WebView, `intercept_navigation` (`social_share.rs:122-134`) проверяет схему, host=`request`, ровно два параметра, текущий URL = источник сервиса, активное приложение, формат payload, хосты CDN | токен виден странице через Navigation API (проход-2, JS-16). Дальше ограничено: подсунуть в диалог «поделиться» чужой пост или медиа с разрешённых CDN. Файл сам не отправляется |
| `chrome.webview.postMessage(token:generation)` для готовности (`multi_app.rs:764-819`) | init-скрипт | токен в замыкании + проверка `has_loaded_document`, `navigation_id`, `sender.Source == args.Source`, https и домен сервиса | подделать готовность — не может: токена нет в глобалах |
| `relay_research_social_reply` (IPC) | `social-read.js` | remote capability `research-social.json` + метка + `first_party(url)` + nonce + эпоха документа + эпоха аккаунта (`research_social.rs:2166-2200`) | сайт может вызвать команду напрямую; успех требует nonce из envelope (`prepare_document_envelope`), который кладётся в страницу через `eval` (`begin_document`). Худший исход — подмена данных результата чтения самой страницей (сайт и так источник данных) |
| `chrome.webview.postMessage(nonce:json)` (Mini App) | `mini-app-bridge.js` | `parse_bridge_event` (`bot_web_apps.rs:52-66`): nonce, generation, top-level origin, `web_app_*`, ≤1 МиБ | nonce не секрет для страницы (приходит ей в `PostWebMessageAsJson`); защищает от чужих фреймов, не от самой страницы. Страница вправе слать любые `web_app_*`, так задумано. Потолка частоты нет (RS-24) |

Вывод: за пределы «подсунуть данные в собственный поток» злонамеренная страница не выходит. Критично, что команды с побочными эффектами (ничего не отправляется без действий пользователя, журнал не принимает пути/URL «снаружи») закрыты на стороне Rust. Реальные дыры в этом слое нашёл только в загрузках (RS-02).

Мелочи проход-2: хуки `window.__egoistRelaySetActive` и `__egoistRelayUpdateShareLabel` не защищены `defineProperty` (в отличие от `__egoistRelayIsShareButton`), `social-read.js:171-175` берёт `__TAURI_INTERNALS__.invoke` в момент вызова (JS-17, JS-18).

### 3.4 Файлы, пути, перезапись, симлинки

[проверено] Сильные решения:

- Публикация файлов: `MoveFileW` (не заменяет), цикл `reserve_destination` до 9999 имён, `symlink_metadata` + `canonicalize` + проверка родителя (`multi_app_downloads.rs:236-261`, `inline_media.rs:185-234`). Атрибут `FILE_ATTRIBUTE_REPARSE_POINT` проверяется.
- `OwnedDirectory` создаётся с `create_new`, `owner.lock` с `share_mode(0)`; чистка устаревших каталогов не трогает занятые (`inline_media.rs:775-929`).
- `safe_file_name` (`multi_app_downloads.rs:282-306`): заменяет `<>:"/\|?*` и управляющие, режет хвост точек и пробелов, резервирует `CON/PRN/AUX/NUL/COMn/LPTn`, ограничивает длину в UTF-16 единицах. Не фильтрует **расширения** (RS-02).
- Журнал: каталог `media-operations` с защищённым DACL `SY + текущий SID` (`media_operations.rs:2148-2212`), запись через временный файл + `sync_all` + `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`.
- Установщик (`installer-processes.ps1`): удаление legacy-файлов только по списку из манифеста, при совпадении размера и SHA-256, внутри `runtime\`, с отказом при reparse point по цепочке.

Риски: `Open` из журнала запускает любой файл через `ShellExecuteW` (RS-06); `OwnedDirectory::cleanup_stale` ограничивается `take(64)` записями за вызов, зависшие каталоги сверх этого не удаляются до следующих запусков (P3).

### 3.5 Запуск внешних процессов

[проверено] Все `Command::new` строят аргументы из констант и абсолютных путей к ресурсам. `shell: true` и конкатенации строк нет. `node.exe` ищется только в каталоге ресурсов приложения (`runtime.rs:10-29`), не в `PATH`. Окружение: удаляются `*proxy*`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `SSLKEYLOGFILE` (`social_share.rs:74-83`), `NODE_PATH` для транспорта. Остальное окружение пользователя (в том числе токены) наследуется yt-dlp и ffmpeg (P3, RS-23). Таймауты: резолвер 125 с / 900 с, `social_share` 64 с / 180 с / 900 с, транскрипция 900 с, пробы `node --version` 2 с. Отмена: флаг + Job Object + `kill`. Вывод ограничен (`take(limit)`).

### 3.6 Named pipe и Control API (мост исследований)

Архитектура: Rust (`research_bridge.rs`) запускает `runtime/research/bridge-server.mjs` и общается с ним по stdin/stdout NDJSON-кадрами ≤256 КиБ. Именованный канал создаёт Node:

- Имя: `\\.\pipe\EgoistRelayAccountBridge-<sha256(state_root)[:24]>-<runtimeId UUID>` (`bridge-server.mjs:136`). Метаданные (имя канала, PID) — в `%USERPROFILE%\.egoist-research\relay-bridge.json`, секрет — в `relay-bridge-token` (32 случайных байта, hex) в том же каталоге.
- Аутентификация: взаимная HMAC-SHA256 «challenge–response». Клиент присылает `hello` с challenge, сервер отвечает nonce и `proof` (HMAC над `id, challenge, nonce, runtimeId, appPid, helperPid`), клиент подписывает запрос (`method` + `params`). `timingSafeEqual`, один запрос на соединение, ≤16 пиров, 5 с на аутентификацию (`bridge-server.mjs:185-250`).
- Приватность каталога: `ensure-private-state.ps1` задаёт защищённый DACL (SYSTEM + текущий пользователь), проверяет владельца, отсутствие hardlink/reparse, размеры файлов, маркер `.research-owned.json`, мьютекс инициализации [проверено, файл прочитан].
- Ограничения запроса: список операций по провайдеру, `FORBIDDEN_INPUT` (в Node и дублем в `valid_input`, `research_bridge.rs:156-188`), глубина ≤12, ≤10 000 узлов, ≤64 КиБ, дедлайн ≤300 с, не более одной `run` на провайдера, `BRIDGE_BUSY` при ≥16 ожидающих.
- ACL самого канала в коде явно не задаётся: `server.listen({ path, readableAll:false, writableAll:false })`. При `readableAll/writableAll = false` Node не вызывает `uv_pipe_chmod`, и действует дескриптор libuv по умолчанию [гипотеза: для NULL-атрибутов безопасности документация `CreateNamedPipe` говорит о праве чтения для Everyone и анонимных; читать-то нечего, пока нет запроса, а запросы требуют HMAC-секрета]. Проверка `accesschk`/`Get-Acl` на живом канале — в разделе 10.

Оценка модели: защита построена правильно для угрозы «другой пользователь/ слабый процесс». От другого процесса **того же пользователя** защиты нет по определению: он читает `relay-bridge-token`. Через мост доступны `read`, `search`, `channel_history`, `chat_export`, `download` и `read_thread` (личные переписки X и Instagram, `research_social.rs:365-374`), а для Telegram ещё `join_chat` (изменяющая операция; подтверждение `confirmedJoin` ставит клиент моста, `src/api/gramjs/methods/research.ts:959`). Журнала обращений и согласия пользователя в приложении нет (RS-08).

PID reuse: `bridge-server.mjs:131-134` — при старте, если в `relay-bridge.json` остался `helperPid` и такой PID жив, запуск отклоняется (`BRIDGE_ALREADY_RUNNING`). Метаданные удаляются только при корректном закрытии помощника. После жёсткого убийства дерева процессов PID может быть занят посторонним процессом; три попытки перезапуска (`research_bridge.rs:99-117`) заканчиваются `BRIDGE_RECOVERY_EXHAUSTED` до рестарта приложения (RS-07).

### 3.7 Обработка URL, SSRF, редиректы, размеры

Слой Rust — allowlist (см. 3.2). Слой Node (проход-2, выборочно перечитан): `media-proxy.mjs` проверяет все A/AAAA и подключается по проверенному адресу (защита от DNS rebinding), закрывает loopback, link-local, CGNAT и документационные диапазоны, принимает только `2000::/3` для IPv6; `social-media-fetch.mjs` проверяет каждый hop редиректа по allowlist (лимит 3), не передаёт Cookie/Referer/Authorization, проверяет формат по сигнатуре; URL подаётся yt-dlp через stdin (`--batch-file -`), поэтому инъекция опций через имя файла невозможна. SOCKS-шлюз резолвера допускает только порт 443 и домены провайдера (`inline-media-resolver.mjs:38`).

Дыра: если системного прокси нет, Rust передаёт `EGOIST_RELAY_MEDIA_PROXY=direct`, шлюз не создаётся (`inline-media-resolver.mjs:84-91, 199, 232-233` [проверено]), yt-dlp получает `--proxy ''` и ходит напрямую без фильтра адресов (JS-02). Для эксплуатации нужен враждебный ответ YouTube/IG/X, поэтому P2.

### 3.8 Секреты и логи

- MTProxy-секрет в JS и Rust-коде отсутствует. Узел читает handoff `%LOCALAPPDATA%\EgoistRelay\interop\lagom-telegram.json` (поля `host, port, schemaVersion, secret`, hex-32), обнуляет буфер после использования (`telegram-transport.mjs:44, 221, 384-393`). Проход-2 нашёл также резервный путь `%ProgramData%\EgoistShield\Runtime\TelegramProxy\config.json` без проверки владельца/ACL (JS-31).
- Токен транспорта: два UUIDv4 (`telegram_transport.rs:53`), в URL query. Валидация URL строгая (`telegram_transport.rs:153-159`). Токен может попасть в `console.error('WebSocket error', event)` (CL-25), а `devtools` включены.
- Cookie X/Instagram: при `MEDIA_AUTH_REQUIRED` Rust читает не более 32 cookie домена (`inline_media.rs:373-479`), передаёт Node-воркеру по stdin, а тот пишет `session-cookies.txt` в каталог задания и удаляет в `finally` (`inline-media-resolver.mjs:231, 266`). Сессионные cookie (`auth_token`, `sessionid`) оказываются на диске в открытом виде на время задания; при аварийном завершении остаются до следующего запуска (`cleanup_stale`). Риск низкий (тот же пользователь), но стоит держать в списке: P3 (RS-22).
- Логи: Rust пишет статусы без URL/путей (`log::info!("[MultiApp] UI state: x ready")`). `eprintln!` с рамками окон в `multi_app.rs` (12 вызовов) безвредны, у GUI-процесса консоли нет.
- Telegram `api_id/api_hash` вшиваются в клиентский бандл (`vite.config.ts:160-161`): для клиента Telegram это норма, но CI публикует артефакт (JS-13).
- Журнал операций содержит пути файлов, URL источников, имена получателей; шифруется DPAPI CurrentUser (энтропия — константа `EgoistRelay/MediaJournal/v1`). Это защита от чтения другим пользователем и от копирования файла, не от процессов пользователя.

### 3.9 Зависимости

Rust: `Cargo.lock` — 652 пакета, `tauri 2.12.0`, `wry 0.57.0`, `tao 0.37.1`, `webview2-com 0.39.1`, `reqwest 0.13.4` (через updater), `rustls 0.23.45`, `url 2.5.8`, `image 0.25.10`, `imageproc 0.27.0`, `zip 4.6.1`. 46 пакетов присутствуют в двух версиях (`png`, `rand`, `windows`, …). Версии Tauri и плагинов закреплены `=`. Advisory-базу не сверял (`cargo-audit` не установлен): **[гипотеза]**, что `cargo audit` чист; CI запускает `cargo audit 0.22.2` и блокирует по числу уязвимостей. Не используются во фронтенде: `tauri-plugin-fs`, `tauri-plugin-os` — можно убрать из сборки без последствий (S, P3).

npm (проход-2): почти все версии с `^`, оверрайдов нет, 5 зависимостей — git-URL без `integrity` (`emoji-data-ios`, `opus-recorder` в production); `esbuild` не объявлен в `package.json`, хотя `build-telegram-transport.mjs:6` импортирует его (JS-08, [проверено]); `.node-version` = `26`, `engines` допускает `^24.11 || ^26`, CI на 24, встроенный Node 24.21.0 (JS-07, [проверено] для `.node-version`).

## 4. Надёжность и данные

### 4.1 Журнал операций (30 дней / 500 записей)

Хранилище: `media-operations\journal-v1.dpapi` = `ERMO\x01\0\0\0` + DPAPI(JSON). Лимиты: 4 МиБ открытого текста, +64 КиБ шифротекста, ≤500 терминальных + 64 активных загрузки + 9 relay-операций (`media_operations.rs:13-28`).

Атомарность [проверено]: полный перезапис через `journal-<uuid>.part` (`create_new`) → `write_all` → `sync_all` → проверка, что цель — обычный файл → `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` (`:1796-1843`, `:2214-2222`). На сбое временный файл удаляется; оставшиеся после падения `.part` вычищаются после первой успешной загрузки (`:1764-1794`). В тестах есть случаи: частичный временный файл, повреждённый журнал, превышение размера, ошибка расшифровки, восстановление после «неопределённого» состояния.

Блокировки: общий `Mutex<Option<Registry>>`; транзакции строятся на копии (`operations.clone()`), так что при ошибке записи память не портится. `commit_known_result` оставляет результат в памяти с `journalWarning`, если диск недоступен. Конкурентный доступ нескольких процессов не поддерживается: единственный экземпляр обеспечивает плагин `single-instance`.

Восстановление: при старте любая незавершённая операция становится `Interrupted`, а отправка в стадии `Sending/Cancelling` — `Uncertain` и не может быть автоматически повторена (`:1310-1337`). Это правильное поведение для «возможно уже отправлено».

Дефекты:

- **RS-03 (P2).** Если файл не читается как положено (`MEDIA_JOURNAL_CORRUPT`, `…_DECRYPT_FAILED`), `Registry::load` кладёт ошибку в `load_error` (`:262-285`), а `ensure_available` (`:287-289`) отказывает **всем** операциям, включая регистрацию любой загрузки (`:355`), до ручного удаления файла. Это сознательный выбор (тест `corrupt_journal_is_preserved_and_blocks_silent_overwrite`), но у пользователя нет пути восстановления: в UI нет обработки этих кодов (`grep MEDIA_JOURNAL_CORRUPT src` — пусто). DPAPI-расшифровка проваливается при сбросе пароля Windows администратором, переносе профиля между пользователями, восстановлении из резервной копии на другой системе. Следствие: все скачивания из Telegram/X/Instagram отклоняются (`downloads::request` → `register_download` → ошибка → `handle_download` возвращает `false`).
- **RS-17 (P3).** Версия схемы жёстко `1` (`:1739`). Любая будущая версия журнала при откате приложения превращается в `CORRUPT`. Нужна политика: читать `version <= текущая`, неизвестные поля игнорировать или ставить «карантин».
- **RS-18 (P3).** Часы: сроки считаются по `SystemTime` (`now_ms`). Перевод часов вперёд на >30 суток удаляет терминальную историю при следующем запуске/запросе списка (`prune_operations`). Назад — некорректных состояний не создаёт (`now.max(updated_at)`).

### 4.2 Загрузки, возобновление, отмена

- Нативные загрузки (`multi_app_downloads.rs`): подготовка из UI (`prepare_download`, TTL 120 с, FIFO по паре URL + имя, ≤128), запрос WebView2 → staging `Downloads\.egoist-relay-media\job-<uuid>\media.part` → наблюдатели COM (`BytesReceived`, `StateChanged`) → публикация без замены → запись в журнал. Возобновления нет: прерванная загрузка помечается ошибкой и отменяется (`Cancel()` в `StateChanged`, потому что WebView2 пытается продолжать сам, `:520-531`). Повтор — только вручную из журнала для операций с `source_url`.
- Отмена: журнал → `cancelled_downloads` → событие → `drain_cancellations` на UI-потоке → `operation.Cancel()` (`:353-361`). Есть защита от гонки «отмена до старта» через `cancel_requested`.
- Резолвер/сохранение (`inline_media.rs`): задание одно за раз (`MEDIA_BUSY` для остальных), дедлайн, отмена, `ActiveGuard`. Потеря дескрипторов не видна: `OwnedDirectory::drop` чистит каталог.
- Размеры: предела на размер нативной загрузки нет, потолок `MAX_FILE_BYTES = 2^50` только для валидации записи (`media_operations.rs:27`).

### 4.3 Жизненный цикл дочерних процессов

- Job Object с `KILL_ON_JOB_CLOSE` для `node` (резолвер, fetch, транспорт) и `whisper-cli`; при гибели приложения (в том числе `panic = "abort"`) ОС закрывает дескриптор и убивает дерево [проверено по `worker_job.rs:45`].
- Окно гонки: `WorkerJob::attach` вызывается после `spawn` (`inline_media.rs:516-524`), потомок, который успеет сам запустить процесс до присоединения, останется вне Job. Практически исключено для Node и whisper (P3, RS-25).
- Помощник исследований не в Job: завершается по EOF/`stdin.end` и `process.ppid`-проверке (`bridge-server.mjs:121`), в Rust добавлено `kill` через 500 мс (`research_bridge.rs:923-931`).
- Чтение stderr ограничено 1 КиБ (`take(1024)`, `inline_media.rs:560`, `social_share.rs:706`). Если дочерний процесс напишет в stderr больше, читатель остановится, и процесс повиснет на записи до дедлайна (P3).

### 4.4 Нет сети, прокси, места на диске

- Нет системного прокси: Rust → `direct`, Node-воркер работает без шлюза (JS-02, 3.7).
- Прокси/PAC: `system_proxy.rs` читает конфигурацию пользователя, поддерживает ручной прокси, bypass-список, WPAD/PAC, ограничивает ответы (256 записей, 8192 символов), выставляет 2 с на фазу, учитывает отмену и дедлайн. Нет автоматического перебора резервных прокси из PAC (сознательно, комментарий `:423-424`).
- Транспорт Telegram: при недоступности моста клиент **молча** идёт напрямую (CL-16, fail-open); `start_transport` при `status = unavailable` не запоминает результат, поэтому каждый вызов UI снова запускает Node и ждёт до 5 с чтения статуса (`telegram_transport.rs:44-74, 138-150`) (RS-16, P3).
- Диск: коды `MEDIA_DISK_FULL` на `write_all/sync_all`; журнал при ошибке записи сохраняет результат в памяти с предупреждением.
- Перед созданием главного окна `setup` выполняет синхронно: `inline_media::initialize` (создаёт и канонизирует каталог загрузок, сканирует staging), `media_operations::initialize` (ACL + DPAPI), `transcription::initialize` (`lib.rs:273-279`). Если «Загрузки» перенаправлены на OneDrive/сетевой диск, запуск окна ждёт файловых операций (RS-05, P2, [гипотеза]).

### 4.5 Миграции профилей и установщик

- Профили WebView2 сервисов лежат вне каталога установки (`%LOCALAPPDATA%\com.egoist.relay\…`), установщик их не трогает; миграция данных между версиями отсутствует и не требуется, пока формат журнала и профилей не менялся.
- NSIS (`tauri/installer.nsh`): проверка 64-бит и сборки ≥18362, ограничение длины пути (208), блокировка понижения версии (в том числе в `/S`), остановка процессов только из каталога установки, приложение не убивается принудительно (код 2 → «закройте через трей»), удаление legacy-рантайма (`xray`, `ciadpi`, `egoist-tg-proxy`) только при точном совпадении байтов и SHA-256, не выходя за `runtime\` [проверено].
- Проход-2 нашёл два сценария сбоя установки/обновления: проверка цепочки reparse-точек над каталогом установки ломает `POSTINSTALL` уже после копирования файлов (JS-04); незавершённые legacy-процессы блокируют удаляемые файлы и завершают установку ошибкой (JS-05).
- Деинсталлятор Tauri по умолчанию предлагает удалить данные приложения; поведение с профилями X/Instagram и журналом не проверял [не проверено].

## 5. Производительность и ресурсы

- **UI-поток.** Команды без `async` в Tauri 2 исполняются на главном потоке (документация Tauri; профилирование не проводилось). Синхронные команды с дисковым вводом-выводом: `relay_media_download_prepare` (`multi_app.rs:170-174`, коммит журнала), `relay_media_operation_action` и `relay_media_operations_list` (`media_operations.rs:765, 821`), `multi_social_detach/restore`, `relay_mini_app_*`, `set_notifications_count` (рендер PNG при каждом обновлении счётчика, `tray/badge.rs`). К тому же колбэк `DownloadStarting` WebView2 выполняет `start_download` → коммит журнала на UI-потоке (`multi_app_downloads.rs:434-454, 128-178`). Каждый коммит — DPAPI, создание файла, `fsync`, `MoveFileExW(WRITE_THROUGH)`, `SetNamedSecurityInfoW` (повторно на каждый вызов, `ensure_private_directory`, `media_operations.rs:1853-1861`). На SSD это единицы миллисекунд, при Defender или медленном диске — десятки (RS-04, P2, [гипотеза] по числам).
- **Число WebView.** Постоянно: главный + `x_webview` + `instagram_webview`; последние два **прогреваются при каждом старте** и загружают x.com и instagram.com скрытыми (`src/components/App.tsx:622-635`). Плюс до 32 Mini App и до 8 popup на каждую; две скрытые «исследовательские» пары создаются лениво. Память — [не измерена], порядок сотен МБ на сервис (RS-09, P2).
- **Фоновые таймеры/опросы.** Помощник исследований: поток с `sleep(250 мс)` и блокировкой реестра, бесконечный (`research_bridge.rs:673-749`); супервизор транспорта: цикл `recv_timeout(100 мс)` + `try_wait` (`telegram_transport.rs:130-133`); watchdog загрузки сервисов — через `Condvar`, без опроса; ожидание процессов — `sleep(30 мс)` на время задания; кэш-очистка Cache API — `setInterval` в каждом контексте (CL-26). Сумма — десятки пробуждений в секунду в простое (P3, RS-26).
- **Блокирующие вызовы в async.** `multi_prewarm_*` и `multi_set_active_app` — `async fn`, но берут `std::sync::Mutex` `WEBVIEW_CREATION_LOCK` и блокируются внутри `add_child` (`multi_app.rs:293-376`). Дедлок возможен, только если главный поток будет ждать этого же замка; сейчас этого нет, но схема хрупка (P3). `relay_get_telegram_transport` держит мьютекс `ACTIVE` до 6 с внутри `spawn_blocking` (корректно).
- **Узкие места передачи.** Предпросмотр: до 64 МиБ в `Vec` → IPC `Response` → `Blob`; транскрипция копирует 64 МиБ аудио (`audio.to_owned()`).
- **Завершение.** `RunEvent::Exit` последовательно ждёт `inline_media` (≤2 с), `transcription` (≤2 с), помощник исследований (≤0,5 с), транспорт (≤0,5 с) — худший случай около 5 с (P3).
- **`find_node_binary`** запускает `node --version` при каждом вызове (`runtime.rs:24-50`; вызовы из `inline_media.rs:493`, `social_share.rs:649`, `telegram_transport.rs:172`, `research_bridge.rs:577`) — лишние 30–150 мс на каждое задание; результат можно кэшировать в `OnceLock` (RS-27, P3).

## 6. Качество, тесты, CI

### 6.1 Rust

- `#[test]`: 114 функций. Покрыты `media_operations` (28), `system_proxy` (22), `research_bridge` (15), `multi_app_downloads` (13), `inline_media` (11), `research_social` (11), `social_share` (7), `bot_web_apps` (3).
- **Без тестов:** `multi_app.rs` (1794 строки, включая allowlist доменов X/Instagram `is_x_internal_url` / `is_instagram_internal_url`, `validate_remote_url`, `is_facebook_auth_path`, расчёт границ), `telegram_transport.rs`, `transcription.rs` (`validate_audio` с ручным разбором WAV), `installer.rs`, `runtime.rs`, `worker_job.rs`, трей (RS-10). Поиск по проекту не нашёл ссылок на эти функции вне `multi_app.rs` [проверено].
- **Тесты, которые не запустятся в CI.** 19 из 28 тестов журнала и 7 тестов `inline_media` вызывают `std::env::var_os("EGOIST_RELAY_TEST_WORK").expect(…)` (`media_operations.rs:2336-2338`, `inline_media.rs:981`). Workflow задаёт только `EGOIST_RELAY_AUDIT_WORK` (`.github/workflows/package-and-publish.yml`, шаг «Select isolated CI work directory»). В `multi_app_downloads.rs:707` написан правильный fallback `TEST_WORK`→`AUDIT_WORK`. Следствие: эти тесты в CI должны падать на `expect` (или их там никто не запускал) [проверено по коду, сам CI не запускался] (RS-05).
- `unwrap/expect/panic/unreachable` вне тестов (после отсечения `mod tests`): 51 место. Из них 10 в `mac.rs` (не Windows), 7 в `tray/badge.rs` (`expect` на кодирование PNG и создание изображений), 9 срезов в `transcription.rs:99-107` (длина проверена выше), 6 в `research_bridge.rs` (`:463-471` после проверки `valid`, `:828`, `:1010`), 4 в `bot_web_apps.rs` (константные URL и сериализация), 4 в `social_share.rs` (`:89, 536, 588, 773`, инварианты проверены выше), 3 в `multi_app.rs`, 3 в `research_social.rs`, 3 в `lib.rs` (`:170, 180, 355`), по одному в `telegram_transport.rs:105` и `tray/mod.rs:24`. Опасных (панику вызывает внешний ввод) я не нашёл [проверено]. Но из-за `panic = "abort"` любая паника убивает весь хаб; стоит включить предупреждения `clippy::unwrap_used`/`expect_used` и заменить хотя бы `badge.rs`.
- `unsafe`: около 116 вхождений слова (из них 26 в `mac.rs`; WinHTTP, DPAPI, ACL, Job Object, WebView2 COM). Контракты FFI описаны в комментариях только местами. Структуры `repr(C)` для `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` сверены с документацией [наблюдение: размеры совпадают], `WinHttp*` и DPAPI используют освобождение через `LocalFree/GlobalFree`.

### 6.2 Node, CI, релиз

- CI (`.github/workflows/package-and-publish.yml`) только `workflow_dispatch`, `permissions: contents: read`, `persist-credentials: false`, `npm ci`, `release-fetch-runtime`, preflight, `npm audit`, `cargo audit` (с блокировкой), `npm run check`, `npm test`, `node --test …`, `cargo test --locked`, сборка NSIS без подписи (`--no-sign`), артефакты на 14 дней, draft только из защищённого окружения `release-review` [проверено по тексту]. Действия закреплены тегами, а не SHA; `dtolnay/rust-toolchain@stable` — подвижная ветка; `windows-latest` не закреплён (JS-06).
- Релизные скрипты: `release-policy`, `release-preflight`, `release-installer.test`, `release-runtime-manifest.json` (хэш и размер каждого файла runtime), `release-fetch-runtime` (скачивание только с GitHub-хостов, проверка SHA-256 до распаковки). Сборка воспроизводима **при условии**, что репозиторий содержит эти файлы — сейчас нет (JS-01).
- Тесты скриптов: `media-proxy`, `social-media-fetch`, `release-*`, `tauri-frame-init`, `mini-app-bridge` (не включён в CI-команду) и ряд UI-аудитов. Для `telegram-transport.mjs`, `release-fetch-runtime.mjs`, `release-sources.mjs`, `x-enhancer.js`, `instagram-enhancer.js` тестов нет; `scripts/regression/*.test.mjs` в шаблоне CI не находит файлов (JS-09).
- Husky: `.husky/pre-commit` не активируется (нет `prepare`) (JS-20).
- Состояние git: 1 коммит `9ec2abd`; `git status`: 652 изменённых, 629 удалённых, 156 неотслеживаемых; `dist/` (12 143 файла) отслеживается, хотя `.gitignore` его исключает; `git ls-files scripts` = 0, `runtime` = 0, `tauri/src` = 7 файлов [проверено].

## 7. Клиентский API-слой (`src/api/gramjs`, `src/lib/gramjs`, `src/util/tauri`)

Проход-2 выполнен отдельным агентом; P1 и ключевые P2 я перечитал.

- **Прокси/транспорт.** MTProxy-секрета в JS нет; клиент получает от Rust `ws://127.0.0.1:<порт>/apiws?token=<64hex>`; валидация URL строгая (`PromisedWebSockets.ts:9-21`); буферы ограничены (8 МиБ исходящих, 64 МиБ входящих). Недостаток: при недоступности моста клиент идёт напрямую и не показывает этого (CL-16).
- **Переподключения.** `MTProtoSender` с идентификаторами соединений, повтор подключения с фиксированным 1 с без экспоненты и без реакции на событие `online` (CL-24); пинг привязан к начальному `sender` и после `_switchDC` бьёт в закрытый sender (CL-07); состояние «connected» может быть оптимистичным при мёртвом апстриме моста (CL-17, [гипотеза]).
- **FLOOD_WAIT.** До 60 с молчаливо × 5 попыток, затем не-RPC ошибка; `sleep` не прерывается сигналом отмены; в `uploadFile` сон без потолка (CL-11).
- **Миграции DC.** `PHONE/NETWORK_MIGRATE` обрабатываются; `USER_MIGRATE` не защищён проверкой авторизации (CL-23, [гипотеза]).
- **Очередь отправки.** Дефекты CL-01…03 (ниже). Локальные «pending» попадают в кэш и переживают перезапуск без пометки «не отправлено» (CL-14).
- **Хранилище.** Auth key лежит в `localStorage` открытым текстом (`sessions.ts:49-73`), а ключ passcode — `SHA-256(passcode + константная соль)` без KDF (`passcode.ts:4, 137-139`) [проверено]. Это поведение апстрима Telegram Web A; в Relay стоит поднять до PBKDF2/Argon2 или хранить сессию через DPAPI (CL-13). `clearStoredSession()` без номера слота чистит слот 1 (CL-12).
- **Черновики.** Сбой сохранения не повторяется; серверный апдейт безусловно заменяет локальный (CL-15).
- **Кэш/IndexedDB.** Лимитов общего размера у Cache API нет, `setInterval` очистки не снимается и запускается в окне и воркере (CL-26); нет защиты от кэша новее приложения (CL-28).
- **Воркер/мастер-окно.** Нет таймаутов запросов через границу воркера (CL-08), ошибка метода на мастере не возвращается неглавному окну (CL-09), выбор мастера по таймауту 100 мс и без heartbeat; `AUTH_KEY_DUPLICATED` не обработан (CL-10).
- **Счётчики:** пустых `catch {}` нет; 5 `catch` только с комментарием; ≈22 `.catch(() => undefined)`; 6 `@ts-ignore/@ts-expect-error`; 114 `as any`/`: any`; ≈86 non-null `!`; 1 `setInterval` без `clear` (`cacheApi.ts:21`); `unhandledrejection` превращается в `console.error` (`handleError.ts`).

## 8. Реестр находок

Формат: **ID [P] — заголовок.** Путь:строка. Сценарий. Влияние. Исправление (трудоёмкость). Статус.

### 8.1 P1

**RS-01 [P1] — команда `relay_inline_save_media` заблокирована ACL.**
Путь: `tauri/build.rs:49-98` (в списке 48 команд, этой нет); `tauri/src/lib.rs:347` (зарегистрирована); `src/util/resolveInlineMedia.ts:48`; `src/components/middle/message/InlineSocialMedia.tsx:121`; правило отказа — `tauri/vendor/tauri/src/webview/mod.rs:2085-2101`; в `tauri/gen/schemas/acl-manifests.json` присутствуют `relay_inline_resolve_media` и `relay_inline_cancel_media`, `relay_inline_save_media` нет.
Сценарий: пользователь нажимает «сохранить оригинал» под встроенным предпросмотром X/Instagram/YouTube. Так как у приложения есть app-manifest, команда без разрешения отвечает `Command relay_inline_save_media not allowed by ACL`. UI показывает ошибку. Команда есть с 1.5.0 (в `docs/release-1.5.0/baseline-changed-sources/tauri/build.rs` её тоже нет).
Влияние: функция недоступна в собранном приложении при любых условиях. Юнит-тесты мокают `invoke` (`InlineSocialMedia.test.tsx`, `resolveInlineMedia.test.ts`), preflight список команд не сверяет.
Исправление: добавить команду в `AppManifest::commands`, выдать `allow-relay-inline-save-media` в `local-media.json`; добавить проверку «каждая команда из `generate_handler!` есть в манифесте и ровно в одной capability» в `scripts/release-preflight.mjs`. (S)
Статус: [проверено статически]; в рантайме не воспроизводил.

**RS-02 [P1] — загрузки из Mini App и popup пишут файлы любого типа и размера в «Загрузки» без подтверждения.**
Путь: `tauri/src/bot_web_apps.rs:117` и `:160` (`.on_download(… handle_download(&view, "telegram", event))`); `tauri/src/multi_app.rs:1394-1419`; `tauri/src/multi_app_downloads.rs:128-178` (ветка без `prepared`: `:143-146` регистрирует операцию сама), `:282-306` (`safe_file_name` не смотрит на расширение); `tauri/src/media_operations.rs:21` (64 активных загрузки), `:27` (потолок 2^50).
Сценарий: пользователь открыл Mini App бота, код которого контролирует автор бота. Страница программно кликает `<a download="Счёт.pdf.exe" href="blob:…">`. WebView2 → `DownloadStarting` → Rust считает загрузку «Telegram», подменяет путь на staging и публикует `Downloads\Счёт.pdf.exe`. Цикл повторяется: файлы произвольного размера (ограничение — диск), 64 одновременных записи в журнале, и легитимные скачивания получают `MEDIA_QUEUE_FULL`; история журнала (500 терминальных) вытесняется мусором.
Влияние: доставка исполняемых и скриптовых файлов (`.exe`, `.bat`, `.js`, `.lnk`, `.hta`) в папку «Загрузки» без подсказки; на обычном Edge/Chrome есть предупреждение для опасных типов и SmartScreen, а здесь SmartScreen отключён дефолтом Wry (`msSmartScreenProtection`), расширения не проверяются; заполнение диска; отказ в обслуживании загрузкам Telegram. Требует действия пользователя (открыть Mini App), поэтому не P0.
Исправление: (a) для `mini-app-*` и popup использовать отдельный обработчик: по умолчанию отклонять; разрешать только после запроса подтверждения в главном окне; (b) denylist расширений (`exe, msi, bat, cmd, ps1, psm1, js, jse, vbs, vbe, wsf, wsh, lnk, scr, hta, jar, dll, reg, cpl, com, pif`) с принудительным суффиксом; (c) лимит размера и частоты на источник; (d) отдельный сервис в журнале («miniapp») и отдельный лимит очереди. Проверить MOTW (раздел 10). (S–M)
Статус: [проверено статически]; наличие `Zone.Identifier` на опубликованном файле [не проверено].

**JS-01 [P1] — репозиторий не воспроизводит сборку.**
Путь: корень; `.gitignore`; `tauri/build.rs:3-4`; `tauri/src/multi_app.rs:38-39`; `tauri/src/inline_media.rs:14`; `tauri/src/social_share.rs:13-14`; `tauri/src/bot_web_apps.rs:11`; `tauri/src/research_social.rs:17`.
Сценарий: `git ls-files scripts` — 0 файлов, `runtime` — 0, `tauri/src` — 7 из 22 файлов; `tauri/installer.nsh`, `installer-processes.ps1`, `installer-legacy-runtime.json`, 6 из 7 файлов `capabilities/` не отслеживаются; `git status`: 652 M, 629 D, 156 ??. Один коммит. `dist/` (12 143 файла) отслеживается. Чистый checkout не соберётся: `include_str!` и `build.rs` ссылаются на отсутствующие файлы; в workflow выполняются `node scripts/release-fetch-runtime.mjs` и `release-preflight.mjs`.
Влияние: нет истории изменений проверенного кода (SSRF-фильтры, журнал, NSIS), нет отката, CI в таком виде не пройдёт; патчи форка Telegram Web A невозможно отличить от апстрима.
Исправление: закоммитить `scripts/`, текстовую часть `runtime/`, `tauri/*`; `git rm -r --cached dist`; расширить `.gitignore` до `runtime/**/*.{exe,dll,bin}`; добавить `.gitattributes`: `runtime/** -text` (иначе CRLF сломает хэши манифеста, JS-11). (S)
Статус: [проверено].

**CL-01 [P1] — альбом не отправляется, если сбой случился у последнего загружаемого файла.**
Путь: `src/api/gramjs/methods/messages.ts:919-932` (catch: `counter--`; `return`), `:953-964` (условие отправки `length < counter`), `:970-985` (`SendMultiMedia`, при `!update` — `return` без пометки об ошибке).
Сценарий: в альбоме A и B. A закончил первым, отправка ждёт B. B падает (сеть, отмена, таймаут). Условие отправки больше никто не проверяет.
Влияние: A остаётся «отправляется» навсегда, запись `groupedUploads[groupedId]` не освобождается, сообщение теряется для пользователя без ошибки.
Исправление: после `counter--` пересчитать готовность и отправить оставшиеся; при полном провале слать `updateMessageSendFailed` всем `localMessages` и вызывать `cancelSendingStatusTimeout`. (M)
Статус: [проверено]. Вероятно унаследовано от апстрима [гипотеза].

**CL-02 [P1] — ошибка отправки без `errorMessage` ломает пометку «не отправлено».**
Путь: отправитель `messages.ts:651-654` (`error: error.errorMessage`); приёмник `src/global/actions/apiUpdaters/messages.ts:1166` и `:1180` (`error.match(…)`).
Сценарий: сетевая ошибка или «Request was unsuccessful 5 time(s)» (`TelegramClient.ts:1319`): у такой ошибки нет `errorMessage` → `undefined.match` → TypeError в апдейтере, который проглатывает `connector.ts`.
Влияние: сообщение остаётся «отправляется» без кнопки «повторить».
Исправление: `error: error.errorMessage ?? error.message ?? 'UNKNOWN'` на отправителе и `error?.match` на приёмнике. (S)
Статус: [проверено].

**CL-03 [P1] — сбой загрузки вложения (single/poll) ничем не помечается.**
Путь: `messages.ts:513-534` (вложение; без `shouldThrowOnSendError` — `await mediaQueue; return;`), `:552-560` (poll).
Сценарий: `uploadMedia` падает (сеть, `FILE_PARTS_INVALID`, таймаут).
Влияние: нет `updateMessageSendFailed`, таймер `FAST_SEND_TIMEOUT` не отменяется; пользователь не видит ошибки и не может повторить.
Исправление: слать `updateMessageSendFailed` и звать `cancelSendingStatusTimeout()` в обеих ветках. (S)
Статус: [проверено].

**CL-04 [P1] — один сбой `getDifference` навсегда отключает восстановление пропусков.**
Путь: `src/api/gramjs/updates/updateManager.ts:375-382` (`seqTimeout = undefined` после `await getDifference()` без `try/finally`), `:438-441` (рекурсивный вызов для `DifferenceSlice` без `await`/`catch`), `:399` (`throw new Error('UpdatesManager not initialized')`).
Сценарий: `getDifference` бросает исключение (ошибка в `processDifference` на кривом апдейте, не инициализирован менеджер).
Влияние: `scheduleGetDifference()` превращается в no-op до `reset()`; пропуски в апдейтах не восстанавливаются, индикатор синхронизации `updateFetchingDifference:true` остаётся.
Исправление: `try { await getDifference() } catch {…} finally { seqTimeout = undefined }`; `await` и `catch` на рекурсии. (S)
Статус: [проверено].

### 8.2 P2

**RS-03 [P2] — повреждённый или нерасшифровываемый журнал блокирует все загрузки без пути восстановления.** `media_operations.rs:262-289`, `:355`, `:1707-1762`; обработки `MEDIA_JOURNAL_CORRUPT` в `src/` нет. Сценарий и влияние — в 4.1. Исправление: при `CORRUPT/DECRYPT_FAILED` переименовывать файл в `journal-v1.dpapi.corrupt-<время>`, запускать пустой журнал, показывать одно предупреждение (хранить не более N копий), добавить кнопку «сбросить историю». (M) Статус: [проверено] по коду; DPAPI-сценарии переноса профиля — [гипотеза].

**RS-04 [P2] — ввод-вывод журнала на UI-потоке.** `multi_app.rs:170-174`; `media_operations.rs:765, 821`; `multi_app_downloads.rs:128-178, 434-454`; `:1853-1861`. Сценарий: каждое нажатие «скачать» синхронно открывает/пишет/синхронизирует файл и меняет DACL. Влияние: подвисания всех трёх WebView на медленном диске и при сканировании антивирусом. Исправление: сделать команды `async` или `#[tauri::command(async)]`, вынести `persist_journal` в выделенный поток с очередью и коалесценцией записей; `ensure_private_directory` выполнять один раз. (M) Статус: [наблюдение]; числа задержек не измерялись.

**RS-05 [P2] — тесты журнала не запускаются в CI + синхронная инициализация перед окном.**
(а) `media_operations.rs:2336-2338`, `inline_media.rs:981` требуют `EGOIST_RELAY_TEST_WORK`; workflow задаёт `EGOIST_RELAY_AUDIT_WORK`. 19 из 28 тестов журнала — «NATIVE». Исправление: общий helper `fn test_work()` с fallback как в `multi_app_downloads.rs:707`. (S) [проверено по коду]
(б) `lib.rs:273-279`: `inline_media::initialize` (создание и канонизация каталога «Загрузки» через `create_dir_all`, `inline_media.rs:156-164, 851-866`), `media_operations::initialize`, `transcription::initialize` выполняются до `create_main_window`. При недоступном/облачном «Загрузки» старт окна задерживается. Исправление: вынести в фоновый поток, ошибки — в журнал. (S) [гипотеза]

**RS-06 [P2] — «Открыть» запускает любой файл через `ShellExecuteW`.** `media_operations.rs:868-875`, `:2242-2252`; расширения не ограничены (`validate_file_name` `:1588-1605`). Сценарий: файл, скачанный из Telegram/X/Instagram (`finish_download`, MIME = `application/octet-stream`), открывается из журнала по клику. С RS-02 цепочка полностью автоматизируема со стороны сайта до последнего клика. Исправление: для не-медиа расширений выполнять только `reveal`; для остальных — `ShellExecute` с `runas`-запретом и проверкой реестра типов. (S) Статус: [проверено].

**RS-08 [P2] — мост исследований как интерфейс «агент → все аккаунты»: нет согласия пользователя, нет журнала обращений.** `research_bridge.rs:143-154`, `research_social.rs:365-374`, `src/api/gramjs/methods/research.ts:959`. Через токен-файл пользователя можно читать личные переписки X/Instagram и Telegram, экспортировать чаты, вступать в чаты (изменяющая операция). Мост работает, пока запущен Relay. Для Social MCP, управляемого языковой моделью, это канал для prompt-injection. Исправление: настройка «Разрешить внешним инструментам доступ» (по умолчанию выключена), журнал вызовов (метод, провайдер, время, результат без содержимого) в UI, обязательное подтверждение для `join_chat` и `read_thread` по умолчанию, лимиты числа запросов. (M) Статус: [наблюдение]; включён ли мост по умолчанию — да, `research_bridge::start` в `setup` (`lib.rs:293`).

**RS-09 [P2] — оба социальных WebView загружаются при каждом запуске.** `src/components/App.tsx:90, 622-635`, `multi_app.rs:293-338`. Сценарий: пользователь запустил только Telegram; Relay открывает x.com и instagram.com и держит их процессы. Влияние: сотни МБ ОЗУ и сетевой трафик, видимые сервису повторные заходы. Исправление: прогрев по настройке или по первому наведению на иконку сервиса. (S) Статус: [наблюдение]; цифры не измерял.

**RS-10 [P2] — нет тестов на allowlist доменов и на транспорт/транскрипцию.** `tauri/src/multi_app.rs` (нет `#[cfg(test)]`), `telegram_transport.rs`, `transcription.rs` (`validate_audio`). Исправление: табличные тесты `is_x_internal_url`, `is_instagram_internal_url`, `validate_remote_url`, `is_facebook_auth_path`; `proptest` для `validate_audio` и `parse_bridge_event`. (M) Статус: [проверено].

**RS-11 [P2] — `ensure-private-state.ps1` может навсегда оставить состояние «не наше».** `runtime/research/ensure-private-state.ps1:53, 66`. Если процесс будет прерван между `CreateDirectory` и записью маркера (таймаут `spawnSync` 20 с в `bridge-server.mjs:99`), следующий запуск встретит каталог без `.research-owned.json` и вернёт `RESEARCH_STATE_UNOWNED`. Мост отключён, пока пользователь не удалит каталог. Исправление: создавать каталог и маркер в одной транзакции (временный каталог + rename) или самовосстановление для пустого каталога. (S) Статус: [гипотеза].

**RS-12 [P2] — холодный старт `tg://` не доставляется.** `tauri/src/deeplink.rs:22-23` (`app_handle.get_webview("main")` при регистрации), `tauri/src/lib.rs:281-296` (`Deeplink::setup` выполняется до `create_main_window`), `get_current()` нигде не вызывается (`grep getCurrent` во `src/` — только `getCurrentWindow`). Сценарий: клик по `tg://…` при закрытом Relay: ссылка попадает в argv, окно открывается, события `deeplink` нет. Исправление: на старте читать `deep_link().get_current()` и отдавать после готовности UI. (S) Статус: [гипотеза], в рантайме не проверял.

**JS-02 [P2] — прямой режим yt-dlp без SOCKS-шлюза и фильтра адресов.** `scripts/inline-media-resolver.mjs:84-91, 199, 232-233`; `tauri/src/inline_media.rs:514`; `scripts/media-proxy.mjs:9`. Сценарий: нет системного прокси → `direct` → `--proxy ''`, собственные DNS и редиректы yt-dlp. Влияние: защита «только публичные адреса, порт 443, домены провайдера» работает не в самом частом режиме. Исправление: для `direct` тоже запускать шлюз (`connectMediaProxy` уже умеет прямое подключение с публичным lookup). (M) Статус: [проверено], эксплуатация [гипотеза].

**JS-03 [P2] — JS плеера YouTube исполняется bundled Node без песочницы.** `scripts/inline-media-resolver.mjs:87` (`--js-runtimes node:<путь>`). Сценарий: yt-dlp запускает Node для решения challenge. Исправление: `--permission` без fs/child_process или JS-рантайм с изоляцией. (M) Статус: [гипотеза] (проход-2).

**JS-04 [P2] — NSIS: проверка reparse-цепочки ломает `POSTINSTALL`.** `tauri/installer-processes.ps1:11-24, 30`; `tauri/installer.nsh:159-174`. Проверка идёт по **всем** родителям каталога установки и вызывается всегда, после копирования. Junction, OneDrive/Dev Drive выше пути → `Abort` с кодом 1 и наполовину установленным приложением. Исправление: проверять цепочку от `runtime\`, а не от корня; при ошибке — предупреждение, не отмена. (S) Статус: [проверено] по коду, [гипотеза] для воспроизведения.

**JS-05 [P2] — legacy-процессы не останавливаются перед удалением.** `tauri/installer-processes.ps1:94-101, 74`. Список процессов не содержит `xray.exe`, `ciadpi.exe`, `egoist-tg-proxy.exe`; заблокированный exe → `Remove-Item -ErrorAction Stop` → код 1 → `Abort` (`installer.nsh:170-174`). Исправление: добавить пути в список (по точному пути в каталоге установки) или считать блокировку «сохранено». (S) Статус: [гипотеза].

**JS-06 [P2] — GitHub Actions по тегам, не по SHA; `windows-latest`.** `.github/workflows/package-and-publish.yml`. (S) [проход-2]

**JS-07 [P2] — разброс версий Node.** `.node-version` = `26`; `package.json` `engines` `^24.11 || ^26`; CI `24`; `release-sources.mjs` и `runtime/README.md` — 24.21.0; `build-telegram-transport.mjs` — `node20`. (S) [проверено частично]

**JS-08 [P2] — `esbuild` не объявлен в `package.json`.** `scripts/build-telegram-transport.mjs:6`; `tauri/build.rs:10-13`. Сборка Rust зависит от транзитивной зависимости. (S) [проверено]

**JS-09 [P2] — тестовые пробелы скриптов.** См. 6.2. (M) [проход-2]

**JS-10 [P2] — нет канала обновления yt-dlp/Node/ffmpeg.** `runtime/README.md`, `scripts/release-runtime-manifest.json`, `inline-media-resolver.mjs --no-update`. Источники сайтов меняются, yt-dlp ломается за недели. Нужна политика выпуска. (M) [наблюдение]

**JS-11 [P2] — `.gitattributes` может сломать хэши runtime.** `* text=auto` без `runtime/** -text`; хэши `.mjs/.ps1/.txt` в манифесте. (S) [гипотеза]

**CL-05 [P2] — кратковременный сбой при старте клиента приводит к `LogOut` и стиранию локальной сессии.** Цепочка `client.ts:161` → `auth.ts:99-107` → `client.ts:168-179` → `global/actions/apiUpdaters/initial.ts:278-279` → `global/actions/api/initial.ts` → `client.ts:209-224`. Сценарий — повторяющийся RPC-сбой `GetState`. (M) [проверено: путь; сценарий — гипотеза]. Ослаблено с P1 до P2: срабатывает при длительном сбое Telegram, а не при обычной потере сети.

**CL-06 [P2] — инициализация воркера может зависнуть без сообщения.** `worker/worker.ts:57-65`, `methods/init.ts:20-22`, `client.ts:118, 178`. (S) [проход-2]

**CL-07 [P2] — цикл пингов привязан к старому sender после `_switchDC`.** `TelegramClient.ts:403, 337-339, 350-353, 523-540`. (S) [проход-2]

**CL-08 [P2] — нет таймаутов на границе воркера/мастера.** `worker/connector.ts:354-437, 463-467`, `MTProtoSender.ts:780-800, 506-508`. (M) [проход-2]

**CL-09 [P2] — ошибка метода на мастер-окне не доходит до других окон.** `util/browser/multitab.ts:359-368`. (S) [проход-2]

**CL-10 [P2] — хрупкий выбор мастер-окна, `AUTH_KEY_DUPLICATED` без обработчика.** `util/establishMultitabRole.ts:8, 12, 148-163`. (M) [проход-2]

**CL-11 [P2] — `FLOOD_WAIT`: молчаливое ожидание и потеря исходной ошибки.** `TelegramClient.ts:138, 1250-1280, 1319`; `uploadFile.ts:92-99`. (M) [проход-2]

**CL-12 [P2] — очистка сессии без номера слота затрагивает слот 1.** `src/util/sessions.ts:76-82`; вызовы в `global/actions/ui/passcode.ts:24`, `global/actions/api/initial.ts:201, 334`. (S) [проход-2]

**CL-13 [P2] — auth key открытым текстом; passcode без KDF.** `sessions.ts:49-73`, `passcode.ts:4, 137-139`. (M–L) [проверено]

**CL-14 [P2] — локальные «pending»-сообщения переживают перезапуск.** `global/cache.ts:885-900`, `global/init.ts:67`. (S) [проход-2]

**CL-15 [P2] — черновики: сбой сохранения не повторяется, серверный апдейт перетирает локальный.** `global/actions/api/messages.ts:1205-1216`, `global/cache.ts:500-509`, `global/actions/apiUpdaters/chats.ts:509-519`. (M) [проход-2]

**CL-16 [P2] — транспорт «fail-open».** `src/util/tauri/telegramTransport.ts:8-13`, `PromisedWebSockets.ts:231-235`. Нет индикации, что трафик идёт мимо Lagom-маршрута; при смерти моста URL не перезапрашивается. (M) [проверено код]

**CL-17 [P2] — «connected» может быть оптимистичным.** `MTProtoSender.ts:398-402`, `PromisedWebSockets.ts:264-272`. (S) [гипотеза]

### 8.3 P3

Rust/Tauri:

- **RS-07.** Ложный `BRIDGE_ALREADY_RUNNING` после переиспользования PID: `runtime/research/bridge-server.mjs:131-134`, три попытки перезапуска (`research_bridge.rs:99-117`) затем `BRIDGE_RECOVERY_EXHAUSTED`. Метаданные удаляются только при корректном закрытии помощника; после жёсткого убийства дерева PID может занять чужой процесс. Исправление: сравнивать время создания процесса (`appStartedAt` уже пишется) и образ. (S) [гипотеза]
- **RS-13.** `default.json` выдаёт шаблону UUID-окон `process:default` (exit/restart) и `core:event:default` (emit) при том, что окон с UUID-меткой нет (см. 2.5). Решение владельца; рекомендация — сузить. (S) [проверено]
- **RS-14.** `tauri/src/installer.rs` — 353 строки мёртвого кода и 6 зарегистрированных команд (`lib.rs:313-318`), для которых есть autogenerated-разрешения, но нет capability. Удалить. (S) [проверено]
- **RS-15.** Устаревшие `permissions/autogenerated/relay_get_network_status.toml`, `relay_reconnect_network.toml`. (S) [проверено]
- **RS-16.** `telegram_transport.rs:44-74` — при `status=unavailable` результат не кэшируется, каждый вызов запускает Node и ждёт до 5 с. (S) [наблюдение]
- **RS-17.** Версия схемы журнала жёстко 1 (`media_operations.rs:1739`). (S)
- **RS-18.** Время по системным часам (`now_ms`). (S) [наблюдение]
- **RS-19.** `validate_remote_url` не закрывает `100.64.0.0/10`, `192.0.0.0/24`, `198.18.0.0/15`, односоставные имена (`multi_app.rs:1352-1361, 1497-1506`). (S) [проверено]
- **RS-20.** `parse_app_url` для Mini App допускает приватные и loopback-хосты (`bot_web_apps.rs:41-50`). (S) [проверено]
- **RS-21.** `multi_app.rs:43-47` — `host-resolver-rules` для `twimg`; хрупко. (S) [наблюдение]
- **RS-22.** Сессионные cookie X/Instagram пишутся на диск в каталог задания (`inline-media-resolver.mjs:231`), остаются при аварийном завершении до следующей чистки. (S) [проверено]
- **RS-23.** Окружение дочерних процессов очищается только от прокси/NODE-переменных (`social_share.rs:74-83`); токены пользователя наследуются yt-dlp/ffmpeg. Использовать белый список (`env_clear` + нужное). (S) [проверено]
- **RS-24.** Нет ограничения частоты `relay-mini-app-event` и запросов загрузки (`bot_web_apps.rs:68-70, 285-295`). Страница может заспамить главный рендерер. (S) [наблюдение]
- **RS-25.** `WorkerJob::attach` после `spawn`; stderr `take(1024)` блокирует разговорчивого потомка (`inline_media.rs:516-524, 558-561`, `social_share.rs:668-707`). (S) [наблюдение]
- **RS-26.** Фоновые опросы: 250 мс (`research_bridge.rs:673-749`), 100 мс (`telegram_transport.rs:130-133`). (S) [проверено]
- **RS-27.** `runtime.rs:10-50` — `node --version` перед каждым заданием; кэшировать. (S) [проверено]
- **RS-28.** Завершение приложения до ~5 с (`lib.rs:356-363`). (S)
- **RS-29.** `tauri-plugin-fs`, `tauri-plugin-os` подключены без выданных прав и без использования во фронтенде (`lib.rs:210-211`); `freezePrototype` не включён. (S)
- **RS-30.** Дублирование `require_main` в трёх местах (`social_share.rs:307`, `transcription.rs:69`, `research_bridge.rs:190`) с разными допустимыми origin (`localhost`, `127.0.0.1` разрешены в двух, не в третьем). Свести к одной функции. (S) [проверено]
- **RS-31.** `set_notifications_count` рендерит два PNG на UI-потоке при каждом обновлении счётчика; кэшировать по значению (`tray/badge.rs:56-177`). (S) [наблюдение]
- **RS-32.** `panic = "abort"` + 7 `expect` в `tray/badge.rs` и один `expect` в `tray/mod.rs:24`. (S)

Узел/скрипты/CI (проход-2, JS-xx соответствуют R-xx их отчёта):

- **JS-12.** Dev-сервер Vite слушает `0.0.0.0`; `http://localhost:1234` в списке Origin транспорта в любой сборке (`vite.config.ts:191`, `scripts/telegram-transport.mjs:29`). (S)
- **JS-13.** `TELEGRAM_API_ID/HASH` вшиваются в артефакт CI (14 дней). Для клиента Telegram это норма, но артефакт публичен при открытом репозитории. (S)
- **JS-15.** Nonce/generation Mini App — корреляция, не секрет (см. 3.3). (XS)
- **JS-16.** Токен «поделиться» виден странице через Navigation API (`social-share-enhancer.js:150`) [проверено, что токен идёт в URL]. Одноразовый токен на запрос. (M)
- **JS-17.** Хуки хоста перезаписываемы страницей (`x-enhancer.js:310`, `instagram-enhancer.js:190`, `social-share-enhancer.js:329`). (XS)
- **JS-18.** `social-read.js:171-175` берёт `__TAURI_INTERNALS__.invoke` в момент вызова. (S)
- **JS-19.** Две копии CSP (`vite.config.ts:275-293` и `tauri.conf.json:24-37`). (S)
- **JS-20.** Husky-хук не активируется. (XS)
- **JS-21.** Диапазоны `^`, git-зависимости, `allowScripts`. (M)
- **JS-22.** Ветка `createDraft` мертва, нет `SHA256SUMS`, нет аттестаций. (M)
- **JS-23.** `social-media-fetch.mjs:52-59` — в file-режиме потолок `maxBytes` перезаписывается. (XS)
- **JS-24.** Нет idle-таймаута на TLS/HTTP этапах. (XS)
- **JS-25.** `finally` в `inline-media-resolver.mjs:267-272` может подменить исходную ошибку. (XS)
- **JS-26.** `child.kill()` убивает только бутлоадер PyInstaller; страхует Job Object. (XS)
- **JS-27.** Сравнение `realpath(tempDir)` хрупко (8.3-имена, junction). (XS)
- **JS-28.** Фильтр IPv6 блокирует NAT64 (`media-proxy.mjs:127`). (S)
- **JS-29.** SOCKS-шлюз резолвера без аутентификации. (S)
- **JS-30.** Мелкие дефекты чтения stdin. (XS)
- **JS-31.** Транспорт Telegram: резервный конфиг в `%ProgramData%` без проверки владельца, при отказе нет причины в `stdout`. (S)
- **JS-32.** NSIS: PowerShell запускается из `$PLUGINSDIR` с `-ExecutionPolicy Bypass`; при переходе на perMachine нужен защищённый каталог. (S)
- **JS-33.** Мёртвые файлы и ссылки в `deploy/`, `scripts/regression/README.md`; `.gitignore:7` скрывает любой каталог `tests/`. (XS)

Клиент (проход-2):

- **CL-18.** `worker.ts:154, 159` — обработчики ошибок воркера могут падать сами. (XS)
- **CL-19.** `client.ts:373-377` — `err.message.includes` при отсутствии `message`. (XS)
- **CL-20.** Параллельные `getDifference` на одном `pts` (`updateManager.ts:438-441`). (S)
- **CL-22.** `scheduleUnmute.ts:20-27` — переполнение `setTimeout` > 24,8 суток. (XS)
- **CL-23.** `USER_MIGRATE` у авторизованной сессии (`TelegramClient.ts:1281-1293, 534-535`). (S) [гипотеза]
- **CL-24.** Повтор подключения без экспоненты и без реакции на `online` (`MTProtoSender.ts:381-423, 1739`). (S)
- **CL-25.** Токен моста может попасть в лог `console.error('WebSocket error', event)` (`PromisedWebSockets.ts:274-279`). (XS)
- **CL-26.** Cache API: нет общего лимита, `setInterval` очистки не снимается и запускается в каждом контексте (`util/cacheApi.ts:13-23, 144-165, 237`). (S)
- **CL-27.** CSP: три источника `_websync_` не нужны (`tauri.conf.json:27`). (XS)
- **CL-28.** Нет защиты от кэша новее приложения (`global/cache.ts:333-344, 439-477`). (S)
- **CL-29.** `mediaDownload.ts:11-26` — отказ `ensureListeners` кэшируется навсегда. (XS) [проверено]
- **CL-30.** `relayResearchBridge.ts:57-60, 99-101, 155-160` — мост не перезапускается после сбоя регистрации. (S)
- **CL-31.** `windowEnvironment.ts:105-112` — второе окно удаляет временные файлы OPFS первого. (S) [гипотеза]

## 9. Что сделано хорошо (сохранить)

1. **Загрузки.** Публикация без замены (`MoveFileW`), резервирование имён, проверка симлинков и reparse-атрибутов, staging с замком владельца, подтверждение размера после `Completed`, чистка устаревших каталогов без трогания чужих. Тесты на коллизии, частичные файлы, FIFO-сопоставление.
2. **Журнал операций.** Транзакции на копии, атомарная замена с write-through, DPAPI + защищённый DACL, версии `attempt/revision`, неизменяемые поля после первой установки, состояние `Uncertain` для отправки, которая могла состояться. 28 тестов, включая повреждение, лимит размера, потерю прав.
3. **Идентификация и каноникализация URL.** Единые правила в Rust и Node: только фиксированные формы постов, никакой пользовательской строки в argv.
4. **Процессы.** Job Object на всё, таймауты, отмена с разрывом дерева, лимиты вывода, очищенное окружение, абсолютные пути к бинарям из каталога ресурсов.
5. **Наблюдатели WebView2.** Идентификатор навигации против гонок «старый документ — новое событие», токен готовности в замыкании, проверка источника `Source == sender.Source`, watchdog с поколениями, реакция на падение рендерера.
6. **Мост исследований.** Взаимная HMAC-аутентификация, один запрос на соединение, проверка потока событий (`validate_event`: привязка аккаунта, ограничения на размер/число, порядок частей текста, закрытие медиа), нормализация кодов ошибок, «draining»-аренда при падении помощника.
7. **Приватное состояние.** `ensure-private-state.ps1` проверяет владельца, ACL, hardlink, reparse, размер, мьютекс; помощник проверяет `appPid == process.ppid`.
8. **Capabilities.** Разделены по файлам и меткам, `local: true`, remote-capability только для одной команды и только для двух меток; каждая чувствительная команда сверяет метку и origin.
9. **Системный прокси.** Асинхронный WinHTTP с отменой и дедлайном, строгий парсер ручного прокси/bypass/PAC, 22 теста.
10. **Транспорт Telegram.** Секрет не покидает Node-процесс, токен в URL проверяется, URL ограничен loopback, лимиты соединений и буферов, восстановление с экспоненциальным бэкоффом.
11. **Установщик.** Блокировка понижения версии, остановка только своих процессов, удаление legacy по хэшам, длина пути, `preflight`.
12. **Вендорный патч.** Один файл, задокументирован, происхождение сверено (подтверждено мной).
13. **Релизный контур.** Манифест runtime с хэшами, запрет updater в конфигурации релиза, `cargo audit`/`npm audit` в CI, права `contents: read`, draft через защищённое окружение.
14. **Дисциплина ошибок.** Стабильные коды вместо текстов, отсутствие `eprintln` с чувствительными данными, журнальные сообщения без путей.

## 10. Не проверено и что нужно запускать

Не проверено (без запуска или без доступа):

- Поведение в рантайме: ни одно утверждение о задержках, памяти, гонках WebView2 не измерялось.
- `cargo audit`, `cargo deny`, `npm audit`, advisory для `ws`, `vite`, `esbuild`, `fflate`, git-зависимостей — не запускались.
- DACL фактического named pipe; MOTW (`Zone.Identifier`) на файлах, опубликованных нативным конвейером; поведение SmartScreen в WebView2.
- Удаление данных деинсталлятором (профили, журнал); перенос профиля на другого пользователя Windows; сброс пароля Windows (DPAPI).
- Холодный `tg://`; поведение при перенаправленных «Загрузках» (OneDrive/сеть).
- Содержимое профилей WebView2, права на них, шифрование на диске.
- Файлы `.env`, `auth`, значения ключей (по правилу).
- `src/api/gramjs/apiBuilders`, `HttpStream`/`HttpConnection` (не читались ни основным проходом, ни проходом-2).
- Бинарники `runtime/*.exe`, `*.dll`, модели: хэши не пересчитывались.

Что запускать (по убыванию ценности):

1. `cargo test --locked --manifest-path tauri/Cargo.toml` с `EGOIST_RELAY_AUDIT_WORK` и без `EGOIST_RELAY_TEST_WORK`; затем с обоими. Подтверждает RS-05 и показывает реальное число пройденных тестов журнала.
2. Smoke ACL: из консоли главного окна `await __TAURI__.core.invoke('relay_inline_save_media', {…})` — ожидается отказ (RS-01); перебор всех 49 команд из `mini-app-*` и `x_webview` — ожидается отказ для всех.
3. Mini App PoC (в тестовом профиле, на тестовой странице с локальным сертификатом): программный `download` с расширением `.exe`, затем `Get-Content -Stream Zone.Identifier` на результате (RS-02).
4. `cargo audit`, `cargo deny check`, `npm audit --audit-level=moderate`.
5. `accesschk64 \pipe\EgoistRelayAccountBridge-*` (или `Get-Acl` через `\\.\pipe\`) для проверки DACL канала.
6. Повреждение копии `journal-v1.dpapi` в тестовом профиле: убедиться, что скачивания отклоняются без объяснения (RS-03); проверить сценарий смены владельца профиля.
7. Профилирование простоя: `Get-Process msedgewebview2 | Measure WorkingSet`, `powercfg /energy`, число пробуждений; сравнить с отключённым прогревом (RS-09, RS-26).
8. Аварии: `taskkill /F /T` приложения во время загрузки и во время работы моста; убедиться, что нет сирот `node/yt-dlp/ffmpeg`, а повторный запуск поднимает мост (RS-07).
9. `cargo clippy -- -W clippy::unwrap_used -W clippy::expect_used` и `cargo fuzz`/`proptest` для `validate_event`, `parse_bridge_event`, `validate_audio`, `safe_file_name`, `canonicalize_media_url`.
10. Холодный запуск `Egoist Relay.exe "tg://resolve?domain=telegram"` при закрытом приложении (RS-12).
