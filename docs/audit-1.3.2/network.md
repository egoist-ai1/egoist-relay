# Relay 1.3.2: маршрут Windows и Lagom

Проверка 30 сентября 2026 года, 18:29–18:32, Москва. Сетевые настройки, службы и процессы приложений в этом аудите не изменялись. Проверены текущие исходники Relay/Lagom, безопасные признаки сохранённого состояния, WinHTTP policy и публичные endpoints без аккаунтов, cookies, тел запросов или загрузки контента. Установленный Lagom — 3.7.9; версия исследованных исходников Lagom — 3.8.0. Наличие функции в исходниках не подтверждает её доступность в установленной версии.

## Подтверждённый отказ внешнего маршрута

Windows не публикует HTTP-прокси: `ProxyEnable=0`, endpoint пуст, явного PAC нет. Нативный `WinHttpGetIEProxyConfigForCurrentUser` сообщает `AutoDetect=true`; WPAD возвращает 12180 для Telegram, Instagram и X за 15/0/0 мс. Это отсутствие обнаруженного PAC, а не ошибка входа в аккаунт. В текущем `tauri/src/system_proxy.rs:161` такой результат без явного PAC применяет manual policy, которой здесь нет, то есть `DIRECT`. Значение 12180 описано в [документации Microsoft](https://learn.microsoft.com/en-us/windows/win32/winhttp/error-messages).

Независимый probe использовал обычные прямые ОС-сокеты, проверку TLS-сертификатов, HTTP/1.1 и срок TCP-соединения 7 секунд. Для Telegram запрос Upgrade имеет `/apiws`, subprotocol `binary` и Origin `http://tauri.localhost`. До отправки этого запроса все пять соединений завершились таймаутом TCP. Данные авторизации не отправлялись.

| Публичный endpoint | Результат текущего DIRECT | Время |
|---|---|---:|
| `zws1.web.telegram.org:443` | Timeout TCP; TLS/WSS не достигнуты | 7 094 мс |
| `zws2.web.telegram.org:443` | Timeout TCP; TLS/WSS не достигнуты | 7 094 мс |
| `zws3.web.telegram.org:443` | Timeout TCP; TLS/WSS не достигнуты | 7 094 мс |
| `zws4.web.telegram.org:443` | Timeout TCP; TLS/WSS не достигнуты | 7 094 мс |
| `zws5.web.telegram.org:443` | Timeout TCP; TLS/WSS не достигнуты | 7 094 мс |
| `www.instagram.com` | TCP 187 мс; reset на TLS, WinError 10054 | 203 мс |
| `www.facebook.com` | TCP 156 мс; reset на TLS, WinError 10054 | 203 мс |
| `x.com/i/flow/login` | TLS установлен; HTTPS HEAD 307 | 625 мс |
| `www.youtube.com` | TLS установлен; HTTPS HEAD 200 | 3 062 мс |

Это воспроизведение показывает отказ до проверки логина для Telegram и Instagram. Оно не определяет, какой именно внешний узел сбрасывает/теряет пакеты, и не доказывает блокировку со стороны конкретного оператора. HTTP 307 у X подтверждает доступность этой точки и редирект, но не подтверждает загрузку всего приложения или успешный вход. Python TLS fingerprint отличается от WebView2; нативную загрузку самого Relay проверяет отдельный release gate.

DC hostname в Relay соответствует текущему [исходнику Telegram Web A](https://raw.githubusercontent.com/Ajaxy/telegram-tt/master/src/lib/gramjs/Utils.ts): `zws1`…`zws5.web.telegram.org`, media DC используют суффикс `-1`. Локатор Relay: `src/lib/gramjs/Utils.ts:176`. Подменять hostname или увеличивать timeout вместо исправления маршрута эти результаты не обосновывают.

## Что сейчас делает Lagom

Core, SystemDoH, TelegramProxy и Zapret наблюдались в состоянии Running. Физический Wi-Fi использует DNS `127.0.0.1`; активный TUN не наблюдался в доступном inventory адаптеров. В сохранённом пользовательском состоянии есть серверы, подписка и валидный выбранный сервер. Их адреса, имена, идентификаторы и credentials не публикуются. `autoConnect=false`, `useTunMode=false`, `routeMode=global`. Выбранный сохранённый сервер и работающая служба DNS не означают подключённый VPN; текущий системный proxy остаётся выключенным.

Локальный TelegramProxy Lagom предоставляет MTProxy-ссылку `tg://proxy`, а не HTTP CONNECT/SOCKS/WSS proxy для WebView2 (`telegram-proxy-manager.js:77`, `:85`). Его работа сама по себе не переводит браузерный Telegram Relay на этот маршрут. Relay не должен угадывать его порт или запускать свой bridge.

Исследованная действующая service definition EGOIST MIX изменена в 13:44 того же дня: `C:/ProgramData/EgoistShield/Runtime/Zapret/service-wrapper/egoistshield-zapret-service.xml`. Она содержит TCP/UDP стратегии для 443, file/inline host selectors и IP selectors. Включённые `list-general.txt`, `list-general-user.txt`, `list-google.txt`, `list-egoist-discord.txt` и inline selector не содержат Telegram/X/Instagram/Facebook family domains. Исключающие domain lists также не содержат этих семей.

Проверены suffix-match доменов и соответствие текущих DNS-адресов включённым/исключающим CIDR для 19 точек: `web.telegram.org`, `zws1`…`zws5`, `t.me`, `x.com`, `api.x.com`, `twitter.com`, `api.twitter.com`, `pbs.twimg.com`, `video.twimg.com`, `www.instagram.com`, `i.instagram.com`, `graph.instagram.com`, `static.cdninstagram.com`, `www.facebook.com`, `connect.facebook.net`. Совпадений с селекторами исследованной definition нет. Положительный контроль `www.youtube.com` совпал с TCP 443 hostlist strategy. Это snapshot текущих DNS и файлов; повышенный live argv winws недоступен, поэтому XML не выдаётся за независимо прочитанные аргументы работающего процесса. Все возможные CDN и IP сервиса не перечислены, их адреса могут меняться.

## Поддерживаемый контракт подключения

Все пути следующей таблицы относятся к `Egoist Lagom/src/` и текущим исследованным исходникам.

| Граница | Контракт и эффект |
|---|---|
| `recovered/preload.cjs:50` | `api.vpn.connect(nodeId?)` вызывает `ipcRenderer.invoke('vpn:connect', nodeId)`. При отсутствии аргумента handler использует выбранный сервер. |
| `recovered/electron/ipc/handlers-vpn.js:618`, `:757` | Подключение проходит штатный coordinator. При текущем `zapretSuspendDuringVpn=true` сначала безопасно приостанавливается собственный DPI. Проверяется внешний egress; при отказе возможны другие сохранённые серверы и восстановление DPI. |
| `recovered/electron/ipc/vpn-manager.js:1020`, `:810` | Runtime выбирает свободные HTTP/SOCKS/API ports динамически и публикует HTTP endpoint через Windows user proxy. Preferred ports не являются постоянным публичным интерфейсом Relay. |
| `recovered/electron/ipc/system-proxy.js:257` | Endpoint имеет loopback authority; менеджер владеет rollback и WinINet notifications. Relay читает системную policy и не записывает registry или rollback. |
| `recovered/electron/main.js:1163` | Second-instance CLI поддерживает `--minimized`/показ widget; CLI-команды VPN connect нет. |
| `service/EgoistShield.Service/ServiceContract.cs:11` | Named pipe `EgoistShield.Service.v1` принадлежит Core. |
| `component-protocol.js:8`, `:44` | Core worker допускает SystemDoH, TelegramProxy и Zapret. VPN не является Core component. |
| `service/EgoistShield.Service/ClientAuthorizer.cs:47` | Production mutation client должен быть установленным executable Lagom; raw запрос от PowerShell/Python не является разрешённым приложением-клиентом. |
| `service/EgoistShield.Service/Program.cs:35` | Core CLI предоставляет ограниченные maintenance/inspection flags; VPN connect среди них отсутствует. |

В live catalogue этой задачи нет Lagom connector/MCP для выбранного VPN. Поэтому штатное подключение текущего пользовательского Lagom не выполнено агентом: отсутствует готовый background interface, адресованный его экземпляру. Renderer IPC — внутренний интерфейс приложения; произвольный CDP eval или отдельный runtime с копией профиля не являются документированным внешним control contract. Профили не копировались, сетевые настройки не менялись.

## Минимальный путь к проверяемому результату

1. Штатно подключить уже выбранный сервер в установленном Lagom. Сначала получить успешную проверку внешнего маршрута в самом Lagom; одного listener/service status недостаточно. Затем повторно прочитать Windows user proxy и фактический маршрут для HTTPS/WSS. Требуется именно активный endpoint из policy, а не фиксированный 10809.
2. После появления рабочего внешнего маршрута повторить холодную загрузку Relay, Telegram WSS, Instagram и X; отдельно проверить формы штатного входа и новую native-media операцию. Для already-open streams смена proxy не означает бесшовную миграцию. Успех логина не заявляется до проверки самим пользователем/разрешённым аккаунтным сценарием.
3. При выборе DPI-only supported Lagom путь — `zapret:save-user-lists` (`handlers-zapret.js:116`), с сохранением всех существующих user lists. `saveUserLists` валидирует и сохраняет все четыре списка, затем managed `reapplyAfterUserListsChange` повторно применяет активный профиль (`zapret-manager.js:820`, `:2192`). Возможные public family additions: `telegram.org`, `t.me`, `x.com`, `twitter.com`, `twimg.com`, `instagram.com`, `cdninstagram.com`, `fbcdn.net`, `facebook.com`, `facebook.net`. Это изменение Lagom, требующее отдельной фактической проверки. Оно не гарантирует доступ при фильтрации до TLS, недоступности внешнего IP или географическом ограничении сервиса. Текущий timeout Telegram происходит до TLS, поэтому одни TLS-hostlist additions нельзя представить как подтверждённое исправление.

## Контракт Relay и оставшиеся границы

Telegram использует браузерный `new WebSocket(..., 'binary')` (`src/lib/gramjs/extensions/PromisedWebSockets.ts:225`). X/Instagram создаются без app proxy override. Native workers получают результат `system_proxy::proxy_for_url` для каждой новой операции (`tauri/src/inline_media.rs:248`, `tauri/src/social_share.rs:482`), а посторонние environment proxies удаляются (`social_share.rs:68`). HTTP CONNECT/SOCKS5 используются только для явно выбранного endpoint; внутренние VPN/DNS/DPI engines для Relay не требуются.

Per-URL PAC и bypass поддерживаются resolver, но native download job сейчас фиксирует route исходного URL для последующих CDN/redirect запросов. Сложная PAC, выбирающая разные routes для страницы и CDN, отдельно не проверена. WinHTTP PAC resolving синхронный: фазовые timeouts не означают общий hard deadline; вызов должен оставаться вне UI thread. Эти границы не воспроизвели текущие отказы: в snapshot нет PAC, manual proxy или TUN.

Прямые публичные probes и чтение policy выполнены успешно как диагностика; Telegram/Instagram connectivity в этом snapshot **не проходит**. Доступ через выбранный VPN, аккаунтные входы, сетевой переход, media downloads и длительная работа требуют дальнейшего release gate. Абсолютная безотказность внешних сервисов не подтверждается этим аудитом.
