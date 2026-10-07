# Relay 1.3.1: наследование сети Windows/Lagom

Дата: 30 сентября 2026, Москва. Проверены текущие исходники Lagom 3.8.0, доступные read-only Windows signals и новый `tauri/src/system_proxy.rs`. Системные настройки, службы, Lagom и пользовательский Relay в этой проверке не изменялись. VPN-профили, enrollment, приватные DoH URLs и ключи не читались. В этом scope реализован только system proxy resolver; удаление внутренних engines, WebView overrides и интеграцию media выполняет root release gate.

## Фактическая архитектура Lagom

| Компонент | Источник | Контракт для Relay |
|---|---|---|
| Windows user HTTP proxy | `Egoist Lagom/src/recovered/electron/ipc/system-proxy.js:257`: `127.0.0.1:${port}`; `:277` пишет ProxyEnable/ProxyServer/ProxyOverride, снимает PAC и проверяет readback; `:56` посылает WinINet notifications | Использовать активную системную политику; не копировать rollback/config и не писать в registry. |
| Динамические VPN ports | `vpn-manager.js:1020`: HTTP preferred 10809; Xray SOCKS preferred 10808; API preferred 10085. `port-utils.js:3` перебирает preferred…preferred+100, затем ephemeral. `vpn-manager.js:810` переключает Windows proxy после подготовки новой сессии | 10808/10809 нельзя фиксировать или искать «живой порт». Endpoint должен поступать из актуальной Windows user config. API port не является application proxy. |
| Xray / sing-box local inbounds | `config-builder.js:28`: отдельные loopback SOCKS/HTTP inbounds; `:144`: sing-box mixed loopback inbound | Внешний runtime принадлежит Lagom. Relay не запускает, не перезапускает и не присваивает его процессы. |
| TUN | `config-builder.js:114`: Xray `egoist-tun` и autoSystemRoutingTable; `:183`: sing-box auto_route/strict_route | Обычные ОС-сокеты наследуют применённые routes. Relay не создаёт TUN, не меняет routes, MTU, интерфейс или приоритет Lagom. |
| System DoH | `system-doh-manager.js:173`: loopback TCP+UDP DNS, default port 53; DNS outbound и direct DoH upstream. `system-doh-service-manager.js:3`: служба EgoistShieldSystemDoH | Порт 53 — DNS, не HTTP/SOCKS/VPN. Системный resolver уже использует выбранный DNS; отдельный Relay DoH не нужен. |
| Global DPI | `zapret-manager.js:3`: EgoistShieldZapret; `:11`: WinDivert drivers; `:2240` отвергает сторонний winws; `:2247` не удаляет shared driver | Relay не должен создавать ещё один winws/WinDivert, останавливать Lagom или менять его hostlists. Трафик обычных сокетов уже проходит действующие системные фильтры. |

Windows user proxy, system DNS, packet DPI и TUN — разные сигналы. Наличие xray-system-doh или running DPI service не означает включённый VPN. Наличие listening port также не доказывает, что он выбран системой.

## Read-only snapshot Windows

На момент проверки:

- WinINet registry: ProxyEnable=0, ProxyServer пуст, явного PAC нет; process HTTP_PROXY/HTTPS_PROXY/ALL_PROXY отсутствуют.
- Нативный `WinHttpGetIEProxyConfigForCurrentUser`: manual proxy отсутствует, PAC отсутствует, **AutoDetect=true**. Отсутствие registry AutoDetect value не доказывает выключенный WPAD.
- Нативный machine WinHTTP default: NO_PROXY. Он не заменяет текущую пользовательскую WinINet configuration.
- Активный physical Wi-Fi использует DNS 127.0.0.1. EgoistShieldSystemDoH и EgoistShieldZapret работают; system DNS runtime слушает loopback TCP+UDP 53.
- Видимых активных TUN adapters и split-default routes нет; default route проходит physical Wi-Fi. Это наблюдение доступного route/interface inventory, а не доказательство отсутствия каждого стороннего VPN/filter driver.
- Старый пользовательский Relay ещё имеет свой Xray и loopback ports 17880/17881/17884. Проверка их не остановила. После установки 1.3.1 отсутствие внутренних helpers проверяет root.

Source-only наличие TUN функции не подтверждает включение TUN сейчас. Current WinHTTP resolver probe для HTTPS YouTube/X/Instagram вернул direct route за 12/1/1 мс. Probe определяет политику, не скачивает эти страницы и не доказывает доступность сервисов.

## Минимальный новый контракт

1. WebView без `.proxy_url(...)`, `--proxy-server`, `--host-resolver-rules` и Relay network engines наследует Windows/Lagom network policy. Microsoft подтверждает системную proxy модель WebView2; Chromium использует WinINet. [Microsoft WebView2](https://github.com/MicrosoftEdge/WebView2Feedback/issues/912#issuecomment-777793722), [Chromium proxy settings](https://www.chromium.org/developers/design-documents/network-stack/proxy-settings-fallback/).
2. Telegram использует официальный WSS transport браузера. Встроенный локальный MTProxy/SOCKS bridge не требуется; его наличие не должно быть prerequisite подключения.
3. Native media/downloader не обязаны автоматически наследовать WinINet. Для каждой новой операции root вызывает `system_proxy::proxy_for_url(target)`, передаёт выбранный endpoint либо явный direct в свой worker и не допускает скрытого environment proxy вместо этой политики.
4. При OS direct используются обычные ОС-сокеты и resolver; существующие system DoH, TUN и DPI остаются владельцами маршрута. При OS proxy используется именно выбранный endpoint. Доступность Instagram через внешний VPN определяется внешней конфигурацией, а не встроенным туннелем Relay.
5. Не выбирать другой endpoint после TCP/HTTP ошибки и не повторять установленный stream. Смена external proxy может оборвать уже начатую загрузку; новая операция перечитает ОС, но helper не обещает бесшовную миграцию установленного соединения.

Никакие специальные порты Lagom Relay не резервирует. Разрешены валидные HTTP/HTTPS/SOCKS5 endpoints из действующей OS policy с port 1…65535 или стандартным default transport port; loopback endpoints допустимы, потому что явно назначены системой. Guess/fallback 108xx, использование DNS port 53 или management API 10085 запрещены этим контрактом.

## Реализованный system proxy resolver

Файл: `tauri/src/system_proxy.rs`. Export: `pub fn proxy_for_url(target: &str) -> Result<Option<url::Url>, String>`.

- Каждый вызов читает active-user connection policy через `WinHttpGetIEProxyConfigForCurrentUser`; global endpoint cache отсутствует. Non-Windows возвращает direct после проверки HTTPS target.
- Только HTTPS target без embedded credentials, длина до 16 KiB; media/provider whitelist остаётся у вызывающего root. Ошибки не сериализуют URL, token, PAC contents или proxy credentials.
- Manual configuration поддерживает single endpoint и protocol entries с semicolon/space separators. `https=host:port` выбирает HTTP proxy transport для HTTPS назначения; explicit `https://` означает TLS к proxy. Явный `socks5://` поддерживается; bare Windows `socks=host:port` отвергается, поскольку SOCKS4/SOCKS5 не должны угадываться.
- Endpoint запрещает userinfo, URL path, query/fragment, unsupported protocols, control characters и invalid ports. Endpoint длина до 2048 bytes; returned WinHTTP UTF-16 strings ограничены 8192 units; entry/rule count до 256.
- Manual bypass: exact/wildcard host, `<local>`, optional scheme и port, включая bracketed IPv6. Matching покрывает полный host, а не substring. Unsupported/CIDR bypass rules возвращают явную ошибку. Invalid active proxy не скрывается behind matching bypass.
- PAC/AutoDetect разрешаются Windows API для каждого target. API output NO_PROXY допускает direct, NAMED_PROXY проходит ту же endpoint validation. `fAutoLogonIfChallenged=false`: domain credentials автоматически не отправляются; authentication challenge возвращает ошибку. Native API не вызывает диалог ввода credentials.
- WPAD «configuration not discovered» (12180) при отсутствии explicit PAC применяет manual policy либо её отсутствие. Ошибка явного PAC, script/download/timeout/auth failure не превращается в direct/manual fallback. Microsoft описывает per-URL PAC semantics и auto-logon control. [WinHttpGetProxyForUrl](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpgetproxyforurl), [WINHTTP_AUTOPROXY_OPTIONS](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/ns-winhttp-winhttp_autoproxy_options).
- `WinHttpOpen`, timeouts и session cache flags относятся только к текущему resolver session; registry, OS services, network configuration и глобальная environment не меняются. WinHTTP allocations освобождаются GlobalFree, session — WinHttpCloseHandle по RAII, включая error paths.

Ограничения: WinHTTP phase timeouts — 2 секунды, но они не являются жёстким total deadline PAC execution/discovery; вызывать helper вне UI thread. PAC resolving выполнен на текущем AutoDetect/no-PAC состоянии, но отдельный authenticated/remote PAC и изменённый live system proxy не устанавливались для теста. Multiple proxy entries ограничены первым выбранным transport, автоматический failover не реализован. Windows PAC и Chromium PAC имеют различия; полное совпадение всех enterprise-policy edge cases не заявляется. Caller должен заново запрашивать route при новом job и не держать старый global client/endpoint. Внутри уже запущенного worker scope смена proxy не заменяет установленное соединение.

## Проверки helper

**8/8** unit tests прошли на Windows в isolated rustc wrapper с действующей project URL dependency; Windows FFI code скомпилирован и linked, предупреждений нет. Проверены dynamic manual port, destination protocol vs proxy transport, SOCKS ambiguity, host/scheme/port/IPv6 bypass, invalid/oversized/credential/path rejection, PAC failure classification, invalid configuration behind bypass и sanitized target errors.

Actual read-only native probe: **3/3 direct** для YouTube/X/Instagram, 12/1/1 мс. Только routetype/timing сохранены в собственный work; private endpoint или PAC contents не выводились. Ранее targeted Cargo `--locked` остановился до компиляции во время обновления version/lock; затем root сообщил результат полного Cargo gate: **16/16** tests passed. Полный gate выполнял root, а helper unit/probe проверены в этом scope.

Release privacy scan выявил synthetic credential URLs в отрицательных Rust tests. Fixture hosts заменены на зарезервированные `proxy.example.invalid` и `video.example.invalid`; проверка запрета credentials сохранена, production logic и scanner не изменены. После правки standalone tests снова **8/8**, Windows FFI compile/link без предупреждений; действующий `assertNoSecrets` для `tauri/src/system_proxy.rs` прошёл.

## QUIC и действующий Lagom DPI profile

Read-only evidence: current service XML `C:/ProgramData/EgoistShield/Runtime/Zapret/service-wrapper/egoistshield-zapret-service.xml` содержит две UDP 443 strategies, fake QUIC payload и TCP 80/443/443 strategies. Running winws — child current service wrapper; XML modification предшествует старту winws. Elevated process argv недоступен, поэтому XML является подтверждённой текущей service definition, а не независимо прочитанной live argv. Содержимое аргументов и IP lists не публикуется.

Referenced hostlists проверены только на публичные service-family matches: list-google содержит YouTube; включённые lists не содержат явных Twitter/Instagram family domains. UDP 443 также имеет ipset selector; соответствие конкретных destination IP этим sets не проверялось. Нельзя обещать, что running Lagom profile покрывает Twitter только по running service status.

Текущий профиль имеет QUIC strategy, поэтому unconditional `--disable-quic` не обоснован отсутствием UDP поддержки. App-scoped flag можно использовать как TCP compatibility mitigation, если повторён конкретный UDP-only failure, но он не добавляет Twitter в hostlists и не заменяет VPN для blocked remote TCP route. При полном наследовании внешней сети рекомендован стандартный QUIC режим до такого воспроизведения; новую system DPI службу Relay не создаёт.

## Что ещё должен подтвердить release gate

- Отсутствие старых engines/runtime artifacts, fixed proxy/DNS arguments, settings и personal enrollment в staged 1.3.1 installer.
- Telegram official WSS, X, Instagram и YouTube на реально выбранной внешней сети после штатного нового запуска.
- Изменение Windows proxy/внешней VPN во время жизни приложения, новая media operation после изменения и корректная ошибка уже оборванной операции без скрытого direct fallback.
- Resume/network switch и внешний Lagom service restart; Relay не должен останавливать эти службы или менять их конфигурацию.

Вывод: новый helper следует текущей OS policy и не требует копирования VPN/DNS профиля Lagom. Доступность сервисов и устойчивость внешнего маршрута остаются свойствами Windows/Lagom/VPN/провайдера. Source/unit/proxy-resolution success не равны проверке реального контента или гарантиям постоянного соединения.
