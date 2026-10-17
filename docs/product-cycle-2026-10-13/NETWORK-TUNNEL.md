# Собственный туннель Egoist Social (1.9.0)

13 октября 2026. Проект — architect_fable, решения — владелец и Opus (руководитель). Этот документ — контракт для исполнителей.

## Решения владельца

1. Приложение автономно: поднимает свой туннель только для своих процессов. Работает на любом ПК и не трогает систему: DNS, маршруты, системный прокси, TUN, драйверы. Права администратора не нужны. Не конфликтует с Egoist Lagom (порты 10808/10809/10085 и диапазон +100, TUN `egoist-tun`, Zapret/WinDivert) и с другими VPN. DNS хоста (127.0.0.1, DoH Lagom) никак не затрагивается.
2. Ключ VPN (ссылка или подписка) и «ссылка DNS» (приватный DoH: любой `https://host[:port]/путь`, например `/dns-query` или `/<id>` у NextDNS и ControlD) вшиты в установщик. В настройках их можно заменить, после чего всё подтягивается заново.
3. Режим отказа выбирал руководитель по поручению владельца («что стабильно работает всегда»). Это **лестница маршрутов**, все ступени свои:
   - ступень 1: VPN + приватный DoH;
   - ступень 2: напрямую + приватный DoH;
   - возврат на ступень 1 автоматический.

   Системный DNS и системный прокси не используются никогда.
   Исключение с версии 1.9.6: Telegram идёт мимо Xray через собственный локальный TG-прокси (`telegram_transport`) с системным DNS и системным маршрутом. В лестницу ступеней он не входит, в статусе у него свой маршрут `LocalProxy` / `Unavailable`.
4. Скрытый в настройках сервис не создаёт сетевой нагрузки.

## Решения руководителя (обратимые, константы)

- `proxy` outbound: `sockopt.domainStrategy = UseIPv4`. Xray разрешает имена через DoH владельца и отправляет серверу IP. Так выполнено требование «DNS наш, туннельно». Цена — +1 RTT на новый домен, дальше работает кэш. Если на замерах появятся лаги или CDN окажется далеко, переключить константу `PROXY_DOMAIN_STRATEGY` на `AsIs`.
- Резервный публичный DoH (`https+local://1.1.1.1`, затем `8.8.8.8`) включён (`DOH_PUBLIC_FALLBACK = true`), когда приватный DoH недоступен. Иначе истёкший DoH валит обе ступени. Статус `dohState: fallback` виден в настройках.
- Звонки Telegram: `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`. Без утечек UDP, но качество ниже.

## Схема

- **Процесс.** Один `runtime/xray.exe` на сессию под `worker_job::WorkerJob` (KILL_ON_JOB_CLOSE). Конфиг лежит в `%LOCALAPPDATA%\com.egoist.relay\network\xray.json`. Модуль — `tauri/src/tunnel/`.
- **Порты.** Три loopback-TCP-порта из 20000–60000. Исключены 10808–10909 и 10085–10185 (Lagom). Каждый проверяется через bind+drop и фиксируется на сессию:

  | Порт | Inbound | Назначение |
  |---|---|---|
  | `P_socks` | `socks`, `udp:false` | весь трафик → `balancerTag: active` |
  | `P_probe_proxy` | `http` | всегда в `proxy` |
  | `P_probe_direct` | `http` | всегда в `direct` |

- **Outbounds.**
  - `proxy` — из ключа, uTLS chrome;
  - `direct` — `freedom`, `domainStrategy: UseIPv4`;
  - `block`.
- **Routing.** `geoip:private` уходит в `block`; исключения — inbounds api и probe. DNS идёт `dns-internal` → балансер `active`. Всё остальное — в `active`.
- **API Xray на защищённом unix-сокете.** HandlerService и RoutingService (`lso`, `adi`, `ado`/`rmo`, `adrules`, `bo`) слушают не TCP, а unix-сокет `network/ipc/api-main.sock` (у проб — `api-probe.sock`). Каталог `ipc` создаётся при старте с DACL `O:{sid}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{sid})`: полный доступ только у текущего пользователя и SYSTEM, наследование отключено (`win_acl::secure_directory`). Если DACL выставить не удалось, туннель не стартует (`TUNNEL_IPC_ACL_FAILED`), возврата на TCP нет. Причина: открытый API давал любому локальному процессу, в том числе другого пользователя Windows, прочитать outbound с ключом (`lso`), открыть inbound на 0.0.0.0 (`adi`) или перенаправить трафик (`adrules`, `bo`, `rmo`).
  - Inbound `api` — `dokodemo-door` с `listen` = абсолютный путь с `/` и **без поля `port`** (с `port` Xray падает с panic `strconv.Atoi` при первом подключении); в `settings` формальные `address: 127.0.0.1`, `port: 1`.
  - Клиентский адрес: `-s=unix:C:/…/api.sock`.
  - Файл сокета после kill остаётся на диске, и новый Xray не стартует («failed to listen Unix Domain Socket»). Поэтому перед каждым запуском файл удаляется, после kill тоже, а `purge_leftovers` чистит `ipc` при старте.
  - Путь сокета: абсолютный, не длиннее 100 байт (предел AF_UNIX — 108), без `"`. Иначе старт с ошибкой `TUNNEL_API_SOCKET_INVALID`. Кириллица и пробелы в пути Xray принимает (проверено тестом).
- **Балансер `active`.** `selector: ["proxy"]`, `fallbackTag: "direct"`, без observatory. Переключает Rust: `xray api bo -s unix:<ipc>/api-main.sock -b active direct` и `... -b active -r` (команды есть в нашей сборке 47cfe999, проверено 13.10.2026).
- **DNS.**
  - `servers`: сначала приватный DoH (основной). Для хоста DoH и хоста VPN — `https+local://1.1.1.1/dns-query` с `skipFallback: true`. Резерв — `https+local://8.8.8.8/dns-query`.
  - `queryStrategy: UseIPv4`.
  - Bootstrap-утечка ограничена двумя именами: хостом DoH и хостом VPN.
- **WebView2 (все окружения, mini-apps, research).** Аргументы собирает одна функция `tunnel::browser_args(service)`:
  - `--proxy-server=socks5://127.0.0.1:P_socks`;
  - `--disable-quic`;
  - `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`;
  - `--dns-prefetch-disable`.

  Правило `--host-resolver-rules` для twimg убирается. С одним SOCKS-прокси у Chromium нет прямого фолбэка, имена уходят в SOCKS, поэтому kill switch для WebView получается сам собой.
- **Медиа из Rust и Node.** `socks5h://127.0.0.1:P_socks`. `system_proxy.rs` удаляется. Пока Xray не готов, возвращается `MEDIA_TUNNEL_UNAVAILABLE`. yt-dlp запускается с `--hls-prefer-native`, потому что ffmpeg не умеет SOCKS.
- **Telegram.** С 1.9.6 Telegram идёт мимо Xray: через собственный локальный TG-прокси (`telegram_transport`) с системным DNS и системным маршрутом. Описание ниже (wss через прокси WebView, MTProxy через `P_socks`) относится к исходной схеме 13.10.2026. Стандартный `wss` Telegram Web A через прокси WebView. Ступень 2б: MTProxy-ссылка из настроек (по умолчанию пусто). Её TCP идёт через `socks5h://127.0.0.1:P_socks`. Файлы Lagom больше не читаются.

## Лестница (`tunnel/ladder.rs`)

- **Состояния:** `Tunnel | DnsOnly | Down`.
- **Пробы каждые 5 с:**
  - через `P_probe_proxy`: `GET http://cp.cloudflare.com/generate_204`, ожидается ровно 204;
  - в `DnsOnly` дополнительно — CONNECT к `web.telegram.org:443`, `x.com:443`, `www.instagram.com:443` через `P_probe_direct`. Это маршрут каждого сервиса.
- **Переходы:**
  - Tunnel→DnsOnly — после 3 отказов подряд;
  - DnsOnly→Tunnel — после 4 успехов подряд и не раньше чем через 60 с в состоянии;
  - минимальное время в любом состоянии — 60 с;
  - после сна или смены сети — внеочередная серия проб.
- **Узлы.** Если в подписке несколько узлов, перед падением в DnsOnly перебираются узлы (`rmo`/`ado proxy`).
- **Статус** (state, node, dohState, по сервисам): событие `relay-network-status` и команда `relay_network_status`.
- **Ограничение.** Ступень 2 не помогает при блокировке по IP или SNI. Тогда интерфейс честно показывает «прямой маршрут недоступен».

## Перезапуск

- Xray упал — перезапуск на тех же портах с backoff.
- Порт занят — повторы до 30 с, затем статус `restart-required`. Пересоздать WebView без потери состояния нельзя.
- Готовность на старте ≤ 1,5 с, затем создаются окна.

## Секреты

- **Источник:** gitignored `provisioning.local.json` в корне проекта, поля `{ key | subscription, doh, mtproxy? }`. Шаблон `*.local.json` входит в `.gitignore` и `BLOCKED_FILE` в `release-policy.mjs`.
- **Установщик.**
  - `build-installer.mjs` кладёт данные в meta хвоста stub-установщика (`installer/src/tail.rs`). NSIS-payload и бинарь Tauri остаются общими.
  - `installer/src/engine.rs` после установки пишет `%LOCALAPPDATA%\com.egoist.relay\network\seed.dpapi`.
- **Приложение.** При старте импортирует seed в `profile.dpapi` с полями `{ embedded, override?, subscriptionCache, bootstrapIps }` и удаляет seed. `override` важнее `embedded`; кнопка «Сбросить к встроенным» возвращает встроенные.
- **Замена в настройках** (`relay_network_apply`) идёт по шагам:
  1. Разбор.
  2. Второй Xray на временных портах.
  3. Проба 204 и проверка DoH, не дольше 10 с.
  4. Атомарная запись.
  5. Перезапуск основного Xray на тех же портах.
  6. При отказе — откат.
- **Подписка.**
  - Загрузка через `P_socks` каждые 12 ч и по кнопке.
  - Форматы: base64 или по строке.
  - Протоколы: vless, trojan, ss, vmess. hy2, tuic и wg пропускаются (это не Xray).
- **Защита локального прокси.** SOCKS и HTTP-порты проб без авторизации на loopback, порт случайный. Ими может воспользоваться любой локальный пользователь ОС, не только процесс того же пользователя. Закрыть это нельзя: Chromium/WebView2 не умеет SOCKS5 с паролем и прокси на unix-сокете. Для процессов того же пользователя защиты нет в любом случае: они могут прочитать и DPAPI. Риск принят. API Xray, которым можно прочитать ключ и перенаправить трафик, от этого риска отделён: он на защищённом unix-сокете (см. выше).

## Задания исполнителям

1. Ядро: `dpapi.rs`, `tunnel/{uri,config,supervisor,ladder,store}.rs` с тестами.
2. Подключение: `lib.rs`, все точки создания WebView, медиа, удаление `system_proxy.rs`, команды `relay_network_*` с отдельным `tauri/capabilities/network.json` (`local: true`, `webviews: ["main"]`), сервисы `enabled`.
3. Telegram: `connectionPolicy.ts`, `PromisedWebSockets.ts`, `telegram-transport.mjs`.
4. Фронтенд: экран «Сеть» (поля, статус, маршрут по сервисам) и маршрут в rail.
5. Установщик и релизная политика: `xray.exe`, лицензии, provenance, `installer-legacy-runtime.json`, `.gitignore`.
6. Ревью другой моделью.

## Приёмка вживую

- Сервисы:
  - Telegram: вход, медиа, голосовые;
  - X: лента и картинки;
  - Instagram: Reels.
- В Resource Monitor внешние соединения есть только у `xray.exe`.
- Ключ заменён на нерабочий: примерно через 15 с статус DnsOnly. Ключ возвращён: не позже чем через 2 мин статус Tunnel.
- Выдерживает сон и пробуждение.
- Работает и с включённым TUN Lagom, и с выключенным.
- Запускается, если порт занят.
- Ставится на чистой машине из одного exe.

## Контракт команд и статуса (общий для ядра и фронтенда)

Все команды регистрируются в `tauri/capabilities/network.json` (`local: true`, `webviews: ["main"]`).

| Команда | Аргументы | Ответ |
|---|---|---|
| `relay_network_status` | — | `NetworkStatus` |
| `relay_network_apply` | `{ vpn?: string, doh?: string, mtproxy?: string }` (пустая строка — очистить override поля) | `NetworkStatus` или ошибка-код `INVALID_VPN` / `INVALID_DOH` / `INVALID_MTPROXY` / `PROBE_FAILED` / `APPLY_FAILED` |
| `relay_network_reset` | — | `NetworkStatus`: вернуть встроенные значения |
| `relay_network_refresh_subscription` | — | `NetworkStatus` или `SUBSCRIPTION_FAILED` |
| `relay_network_set_service_enabled` | `{ service: 'x' \| 'instagram', enabled: boolean }` | `NetworkStatus` |

Событие `relay-network-status` с полезной нагрузкой `NetworkStatus` (camelCase):

```ts
type NetworkStatus = {
  state: 'starting' | 'tunnel' | 'dnsOnly' | 'down' | 'restartRequired' | 'notConfigured';
  source: 'embedded' | 'override' | 'none';
  vpnKind: 'link' | 'subscription' | 'none';
  nodeLabel?: string;          // имя узла из ссылки/подписки (#fragment, profile-title), без адреса и ключа
  nodeCount: number;
  dohState: 'private' | 'fallback' | 'down' | 'none';
  dohHost?: string;            // только хост DoH, без пути и токенов
  hasMtproxy: boolean;
  services: Record<'telegram' | 'x' | 'instagram', 'tunnel' | 'direct' | 'unavailable' | 'disabled' | 'unknown'>;
  subscriptionUpdatedAt?: number; // unix ms
  lastError?: string;          // код, без секретов
};
```

Значения ключей, полные URL подписок и DoH никогда не возвращаются во фронтенд и не пишутся в журнал. В полях ввода видно только «встроенный ключ» / «свой ключ» и узел.
