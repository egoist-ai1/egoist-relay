# Egoist Relay 1.2.5: аудит сетевого слоя

Дата: 29 сентября 2026. Исходная установленная версия: 1.2.4. Проверка исходников относится к рабочим файлам проекта на момент начала аудита, включая уже существовавшие изменения; это не сравнение с чистым Git HEAD.

## Что проверено

Управление встроенными процессами, владение портами, статус локальных служб, повторный запуск, конфигурация Telegram bridge, MTProto framing, backpressure, heartbeat, журналирование и альтернативный launcher. После уточнения пользователя добавлены автономный SOCKS шлюз с DoH и отдельный разбор действующего Zapret Lagom. Проверки используют собственные локальные серверы и отдельные процессы; авторизация и изменение аккаунтов не нужны. Системный proxy, DNS, маршруты, firewall и чужие процессы в этой сетевой подзадаче не менялись.

В начале проверки порты 1080, 1443 и 1444 уже имели listeners. Прежняя проверка SOCKS greeting не различала Relay и другой совместимый сервис. Встроенный Telegram launcher действительно открывает порт через дочерний процесс: отдельный контрольный запуск показал launcher PID 23688 и listener PID 53612. Поэтому простого равенства PID для Telegram недостаточно.

Это сетевая часть аудита. Отправка и пересылка в реальных аккаунтах, UI, нативные WebView и проверка окончательного установщика относятся к общему отчёту релиза.

## Найденные проблемы и выполненные изменения

| Приоритет | Наблюдение | Изменение и проверка |
| --- | --- | --- |
| P1 | Любой SOCKS5 listener на 1080 принимался за готовый proxy Relay | Отдельный порт 17880, проверка владельца через таблицы TCP Windows и живой managed handle; чужой listener не принимается и не завершается |
| P1 | Telegram мог автоматически использовать общую конфигурацию Egoist Shield и порт 1443 | Собственный порт 17883; внешний Telegram proxy требует явного `EGOIST_RELAY_TG_PROXY_SECRET` или `EGOIST_RELAY_PROXY_CONFIG` |
| P1 | Совпадающий HTTP health другого bridge принимался без проверки PID | Отдельный порт 17884, TCP owner и `health.pid` должны соответствовать собственному Node-процессу |
| P1 | Завершение Telegram launcher оставляло его дочерний listener, который блокировал последующее восстановление | Воспроизведено на встроенном executable: после завершения launcher PID 40584 listener PID 51984 оставался через две секунды. Cleanup теперь проверяет цепочку родителей и собственный Job Object, держит process handles и повторно проверяет цепочку перед завершением. После исправления listener PID 53364 освобождается |
| P1 | Одна неудачная проверка с 300 мс чтения могла инициировать остановку живого helper и reload соцсетей | Чтение health до 1500 мс; для живого собственного процесса нужны три последовательные неудачные проверки. Завершившийся процесс запускается без этой отсрочки. Неуспешные запуски имеют задержку 3/6/12/24/30 секунд |
| P1 | Новое соединение bridge заново читало конфигурацию, тогда как health описывал конфигурацию старта | Конфигурация фиксируется на срок жизни bridge. Контрольная смена файла между соединениями не меняет upstream; смена применяется после перезапуска |
| P1 | Неверный port/secret молча заменялся значением по умолчанию | Явная неверная конфигурация завершает startup с ошибкой без значения секрета в диагностике. Нативный startup также отвергает одинаковые порты служб |
| P1 | При давлении входящей очереди heartbeat мог считать недоступным браузер, чтение которого сам bridge приостановил | Heartbeat учитывает давление обеих сторон; входящие данные подтверждают живость; обработчик `drain` не возобновляет WebSocket, если следующий flush снова приостановил ввод. Локальный сценарий с пятью пакетами по 4 MiB воспроизводит отказ исходника и проходит после изменения |
| P2 | Любая HTTP(S)-страница localhost могла обращаться к bridge | Разрешены штатные Tauri origins и dev origins на 1234/1235; отсутствующий origin, внешняя страница и localhost на другом порту отвергаются |
| P2 | Журнал дописывался синхронно и без предела | Асинхронная очередь до 64 KiB, текущий файл до 5 MiB и один предыдущий файл. Существующий файл 6 MiB ротируется; передача продолжает работать. При перегрузке журнала записи могут быть пропущены |
| P2 | Неверный DC подменялся DC2; POST мог читать health | Неверный DC закрывает только это соединение с 1008; health отвечает только на GET |
| P1 | `start-relay.mjs` открывал Edge без настройки общего proxy и оставлял detached bridge | Launcher запускает существующий Tauri CLI в текущем процессе. Нативное приложение управляет WebView, профилями и helper lifecycle; `--help` этого входа проверен без запуска приложения |
| P1 | Сам ciadpi не предоставлял приватный DNS для всего proxy трафика | Добавлен `app-proxy.mjs`: домен разрешается выбранным `app-dns.mjs`, все адреса проверяются, в backend передаётся только числовой публичный IPv4. Реальный DoH протокол проверяет отдельная media/DNS матрица; локальная gateway матрица проверяет маршрут и запрет fallback |
| P1 | Ранняя FIN upstream во время SOCKS handshake оставляла ожидание до общего deadline | Первая gateway матрица воспроизвела ошибку. Явный обработчик `end` до успешного CONNECT возвращает отказ сразу; соответствующий случай проходит |
| P1 | Прежний CLI guard не совпадал с именем bundle, создаваемым native runtime | Поддержано `egoist_relay_app_proxy_<PID>.cjs`; собственный реально собранный и переименованный fixture запускается по stdin и передаёт numeric SOCKS поток |

Нативный Telegram owner допускается как прямой managed PID либо как его потомок с подтверждённой цепочкой родителей и принадлежностью собственному Windows Job Object Relay. Это проверено на реальном встроенном executable, а не только на фиктивном JSON health.

Дополнительный `can_use_managed_dpi_route()` разрешает маршрут к ещё свободному порту и собственному DPI listener. Чужой listener на 127.0.0.1, IPv4 wildcard или IPv6 wildcard и ошибка чтения таблицы TCP приводят к отказу. Это поддерживает восстановление WebView после позднего старта helper, не принимая уже занятый чужой порт за Relay.

Скрипт bridge и его журнал размещаются в app-local runtime. Контролируемые smoke-запуски используют `runtime` внутри явно переданного отдельного test profile. Нативный запуск Node удаляет `NODE_OPTIONS` и `NODE_EXTRA_CA_CERTS` из среды своего helper.

## Текущий сетевой контракт

| Служба | Адрес по умолчанию | Назначение |
| --- | --- | --- |
| App SOCKS шлюз | `127.0.0.1:17880` | WebView и media; DNS доменов через выбранный DoH, числовые адреса проверяются |
| ciadpi backend | `127.0.0.1:17881` | TCP к публичным адресам; native integration задаёт `-N -U`, запрещая собственный domain lookup и UDP |
| Telegram helper | `127.0.0.1:17883` | Совместимая прежняя MTProxy ветка, если SOCKS route явно не задан |
| WebSocket bridge | `127.0.0.1:17884` | По умолчанию generic SOCKS route к app gateway; поддержаны прежняя MTProxy и опциональная tunnel ветки |

Нативное приложение управляет распределением портов и передаёт gateway ровно три поля `{listenPort, upstreamPort, providerUrl}` по ограниченному stdin. Допустимы целые порты 1–65535, front и backend должны различаться. Relay не подбирает случайный новый рабочий маршрут при коллизии и не останавливает чужого владельца порта. Смена конфигурации требует перезапуска соответствующего процесса/WebView. URL DoH не передаётся через args/env и не присутствует в health/ошибках gateway.

Нативный статус `ready` подтверждает локальный протокол и ожидаемого владельца. Он не подтверждает доступность всех Telegram DC, X, Instagram или CDN. Установленное MTProto-соединение при потере upstream закрывается; новый сеанс и повтор запроса выполняет клиент. Bridge не воспроизводит произвольные уже отправленные пакеты через новый TCP-сеанс.

### Telegram через общий SOCKS маршрут

`EGOIST_RELAY_SOCKS_PORT` выбирает общий app SOCKS route. Сохранён `EGOIST_RELAY_TUNNEL_SOCKS_PORT` для опционального Xray route. Обе ветки подключаются только к `127.0.0.1` на указанном SOCKS5-порту, затем выполняют CONNECT к официальному TCP endpoint Telegram на 443. Прежний Telegram helper, его secret и config в этих ветках не используются. Последнее уточнение пользователя выбрало автономный DoH/DPI режим для личного установщика; наличие tunnel кода не означает включение удалённого VPN по умолчанию.

Health содержит `route: socks`, `tunnel` или `mtproxy`. Для SOCKS `proxy` указывает локальный endpoint, `transport` равен `intermediate`; `protocolVersion` остаётся 3. Разные одновременно заданные generic/tunnel порты завершают startup; одинаковые выбирают `socks`. Неверный или совпадающий с bridge порт также завершает startup. Конфигурация сохраняется на срок жизни процесса. При ошибке нет перехода к MTProxy или прямому TCP.

Внутри SOCKS соединения используется сырой obfuscated TCP Telegram: AES-CTR keys извлекаются из random header без MTProxy-secret SHA-256. DC-поле MTProxy не подставляется в raw header. Обычный и media запрос выбирают адрес своего DC; test выбирает отдельный test endpoint. SOCKS CONNECT передаёт IPv4-адрес числом, поэтому bridge не разрешает имя дата-центра локально.

Начальные адреса соответствуют [списку встроенных DC официального Telegram Desktop](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/mtproto/mtproto_dc_options.cpp): production DC 1–5 и test DC 1–3. Test DC 4/5 отвергаются до подключения к SOCKS. Bridge пока не получает динамические `dc_options` или произвольные CDN DC из клиента. [Telegram](https://core.telegram.org/api/datacenter) предупреждает, что endpoint может меняться; фиксированный начальный список не заменяет полную обработку динамической конфигурации.

## Что означает изоляция

Реализована изоляция настроек приложения и собственных локальных служб. Отдельные порты и проверка процесса устраняют неявное использование уже работающего VPN/proxy на обычном 1080. Общие переменные proxy среды, выбор внешнего маршрута, WebRTC/QUIC и media workers проверяются и согласуются в общем аудите приложения.

В базовом localDpi режиме `ciadpi.exe` версии 17.3 является локальным SOCKS/DPI helper. DoH выполняет новый app resolver перед передачей числового IP в ciadpi; `-N` отключает domain requests в backend. Это не удалённый VPN: исходящие соединения используют маршрутизацию ОС, включая действующий системный VPN. [ByeDPI](https://github.com/hufrea/byedpi/blob/main/README.md) описывает локальный SOCKS server и отдельно отмечает синхронный domain lookup без `-N`.

Отдельная опциональная ветка предусматривает собственный Xray и удалённый endpoint. Системная маршрутизация всё равно определяет, как достигается endpoint. Автоматический переход между localDpi и tunnel не предусмотрен. Доступность удалённого узла и фактическое шифрование должны быть подтверждены тестами собранного приложения, а не локальным `/health`.

Для Telegram bridge DNS дата-центра не нужен: SOCKS получает адрес DC числом. Для доменных запросов gateway применяет DoH и pinning публичного IPv4. Эта исходниковая матрица не доказывает отсутствие любых других DNS запросов WebView/ОС: настройки Chromium, updater и прочие исходящие пути входят в общий аудит. Уже действующий глобальный WinDivert также может обработать исходящие пакеты ciadpi; независимость от установленного Lagom требует проверки на чистом втором ПК/VM.

Origin-проверка ограничивает доступ веб-страниц. Она не является аутентификацией произвольного локального процесса, который может самостоятельно сформировать HTTP-заголовки. Проверка PID и Job Object относится к собственным helper; это не защита от вредоносного ПО с полномочиями того же пользователя.

## Проверки и evidence

Среда: Windows NT 10.0.26200.0, Node 24.19.0, Rust 1.98.1. В тестах не менялись системные сетевые настройки и пользовательские профили.

| Проверка | Результат |
| --- | --- |
| Одна и та же итоговая Node-матрица, исходный bridge | 19 случаев: 11 pass, 8 fail, 0 cancelled |
| Bridge после первоначального исправления | 19/19 pass, 0 cancelled |
| Bridge с опциональным tunnel route | 39/39 pass: исходные 19 и ещё 20 tunnel случаев; 0 cancelled |
| Итоговая gateway + bridge матрица | 84/84 pass, 0 skipped/cancelled: 37 gateway и 47 bridge; сохранены прежние 39 bridge cases |
| Gateway: DoH route contract | Lazy initialization; один init для одновременных доменов; фиксированный provider; cooldown после init failure; numeric DC не вызывает DNS; private/rebinding/IPv6 output отвергается |
| Gateway: ограничения SOCKS | Только CONNECT 80/443; BIND/UDP/auth, raw IPv6, private/multicast/reserved targets и regular HTTP CONNECT запрещены; backend получает только числовой IPv4 |
| Gateway: нагрузка и lifecycle | 16 MiB bytes совпадают при паузе backend 400 мс; writable queue не превышает 1 MiB; 504 SOCKS handshakes сохраняют health slots; idle/half close, loss без replay, cancel during DNS, own shutdown/foreign port проходят |
| Gateway CLI | stdin больше 64 KiB, лишние поля и неверный URL отвергаются постоянной ошибкой; реально переименованный CJS bundle стартует и передаёт SOCKS bytes; provider token отсутствует в output |
| Фрагментированный obfuscation header и пакет; короткий/extended frame, порядка 4 MiB | Обе transport-ветки intermediate/padded проходят, bytes совпадают |
| Signed media/test DC, шифрование последовательных пакетов, quick ACK | Обе transport-ветки проходят |
| 20 соединений × 5 пакетов по 16 KiB | Порядок и bytes совпадают, health остаётся доступен |
| Поздний старт proxy через 400 мс; потеря upstream; занятый bridge port | Очередь передаётся после startup; потерянный сеанс закрывается; существующий listener сохраняет свой PID и отвечает |
| Backpressure: пять пакетов по 4 MiB, остановка чтения upstream на 500 мс | Исходник закрывает соединение, исправленный bridge передаёт все bytes. Только для этого случая период heartbeat ускорен с 30 секунд до 200 мс в обоих исходниках |
| Windows ownership и parent-death harness из реальных функций `network.rs` | 4/4: IPv4/IPv6/wildcard ownership и free/foreign route, настоящий bundled TG launcher → дочерний listener в Relay Job Object, границы цепочки потомков, освобождение listener после parent-only завершения |
| SOCKS tunnel framing | 16 ordinary/media sessions для production/test DC; raw key derivation, short/extended packet, около 4 MiB, quick ACK; фрагментированные IPv4/domain/IPv6 SOCKS replies проходят |
| Tunnel отказ и восстановление | Неверные auth/version/REP/ATYP/size, неполный reply, отсутствующий endpoint, поздний startup, потеря установленного upstream, недопустимый test DC и неверные порты; прямой TCP и разрешение внешнего hostname запрещены test guard |
| Cargo проекта | До последнего cleanup и tunnel-интеграции основной аудит подтвердил 17/17, включая 7 сетевых тестов. На момент передачи cleanup source содержал 8 сетевых тестов; повторные native gates относятся к общему релизу |
| Синтаксис gateway/bridge, адресный ESLint gateway/bridge и двух test файлов | Exit 0; ранее launcher синтаксис и ESLint также прошли |
| `node scripts/start-relay.mjs --help` | Exit 0, штатный Tauri dev CLI |

В исходной матрице из 19 случаев запуск исходного bridge заменяет только константу пути журнала, чтобы не писать в общий TEMP. Ускорение heartbeat одинаково применяется к обеим сравниваемым версиям; остальных production-таймаутов эта матрица не изменяет. Тесты не используют аккаунты, реальные сообщения или CDN в качестве fixture.

В новых tunnel fixtures SOCKS server передаёт поток в локальный DC fixture, сохраняя записанный production/test CONNECT адрес для проверки; внешних TCP-соединений не создаётся. Во всех tunnel случаях test guard запрещает любой TCP endpoint кроме собственного SOCKS и разрешение внешнего hostname. Для проверки неполного SOCKS reply connect timeout ускорен с 5000 до 200 мс; это не измерение реального WAN timeout. Ошибка первого запуска этих fixtures была в чрезмерно строгом test guard, запрещавшем даже внутренний Node lookup числового loopback при `listen`; guard исправлен без изменения production-кода.

Gateway fixtures инъецируют resolver и локальный SOCKS backend через source factory; production stdin не допускает fixture hooks. Отдельный случай проверяет настоящий default socket path, запрещая любой direct TCP и OS hostname lookup кроме числового loopback. Media/DNS агент отдельно проверяет реальный TLS/DoH wire protocol. Для deadline/cooldown/truncated reply случаев gateway константы 15/30 секунд ускорены до 150 мс только в копии исходника внутри task work; для established idle case ожидание превышает этот ускоренный deadline. Gateway capacity набирается партиями по 24 до 504, а не одновременным SYN burst. Первый burst fixture получил ECONNREFUSED Windows и не служит доказательством устойчивости к 504 одновременным новым TCP подключениям.

В первой gateway матрице было 29/34 pass. Один реальный дефект — early upstream EOF до CONNECT; три EOF failures относились к Reader fixture с `allowHalfOpen`, ожидавшему только `close`, а не `end`; capacity failure был описанным SYN burst. После адресных исправлений 34/34, затем расширенная итоговая матрица 84/84. Фикстуры перенесены из игнорируемой Git папки `scripts/tests` в `scripts/regression`; после переноса снова 84/84 и ESLint exit 0. Для повторения задайте собственный абсолютный task work через `EGOIST_RELAY_AUDIT_WORK` и выполните `node --test scripts/regression/app-proxy.test.mjs scripts/regression/proxy-bridge.test.mjs` из проекта.

## Автономный DNS/DPI: контракт gateway

Gateway слушает только IPv4 loopback, допускает максимум 512 локальных TCP sockets; 8 слотов зарезервированы для health, поэтому максимум SOCKS sessions — 504. Front поддерживает no-auth SOCKS5 CONNECT 80/443. HTTP на том же порту обслуживает только GET `/health`; regular HTTP proxy CONNECT отсутствует. Доменные байты должны быть ASCII/punycode; raw IPv6 и IPv6-only DNS пока отвергаются. Выбранный DoH URL валидируется общим `parseAppDnsProvider`: HTTPS, provider port 443/8443, длина URL до 4096 и path/query до 2048, без credentials, fragment, private hosts, управляющих символов или backslash.

DNS создаётся при первом domain CONNECT. Числовые публичные IPv4 подключаются сразу. Неудачный init возвращает отказ запросу и оставляет шлюз доступным; следующая попытка через 30 секунд использует тот же provider. DNS ошибки не закрывают установленные потоки и не включают direct/fallback route. Для custom provider имя самого DoH узла bootstrap разрешается по ограниченной HTTPS матрице Cloudflare, затем Google через тот же backend с числовым IP; запросы целевых имён после pinning идут выбранному provider. Это bootstrap исключение отражено в resolver implementation, а не скрытая смена основного DNS.

Handshake имеет deadline 15 секунд, после успешного CONNECT idle timeout отсутствует. Используется TCP backpressure; pre-handshake/application buffer до 256 KiB, контроль writable queue до 1 MiB на направление. Потерянный established stream закрывается, его запросы не повторяются через новое соединение. `/health` описывает service/PID/protocol, frozen upstream и безопасное DNS summary со state `waiting`, `initializing`, `unavailable`, `ready`/`closed`; доступность сайтов из этого не выводится.

## Что фактически работает в Lagom и что переносимо

Read-only проверки registry, service wrapper XML/log, CIM и runtime файлов подтвердили профиль `general (EGOIST MIX)` в `C:\ProgramData\EgoistShield\Runtime\Zapret`. `VERSION.txt` содержит 1.10.3; это версия runtime package, а не подтверждённая версия native winws. Последняя проверка в 15:36 MSK: winws PID 35404, parent 52780, создан 15:14:34; wrapper log фиксирует тот же PID и аргументы. Ранее PID был 31440 с 28 сентября. Во время работы появилась внешняя reinstall/start запись 29 сентября 15:14; эта сетевая подзадача службы не меняла. Значение профиля, десять групп фильтров и binary hashes сохранились.

| Группа | Фактическая стратегия активного профиля |
| --- | --- |
| 1 | UDP 443, general hostlists: fake QUIC Google, repeats 11 |
| 2 | UDP 19294–19344/50000–50100, Discord/STUN: fake ACTIVE_DISCORD_UDP, repeats 6 |
| 3 | TCP 2053/2083/2087/2096/8443, discord.media: multisplit, split 1, seq overlap 681 |
| 4 | TCP 80/443 Discord list: hostfakesplit, repeats 4, ts/md5sig, fake host ozon.ru |
| 5–6 | TCP Google/general: fake,multidisorder, split 1/midsld, repeats 11, badseq, randomized/duplicate-session Google TLS fake |
| 7–8 | IP set: UDP QUIC fake и TCP fake,multidisorder с exclusions |
| 9–10 | Текущий game filter TCP/UDP 12: any protocol, cutoff n4/n2, TLS/unknown/game fake |

Общий WinDivert filter охватывает TCP 80/443/2053/2083/2087/2096/8443/12 и UDP 443/19294–19344/50000–50100/12. Фильтра по Relay PID нет. По [официальной документации WinDivert](https://reqrypt.org/windivert-doc.html) NETWORK layer поддерживает изменение пакетов без PID; FLOW/SOCKET дают PID с другими ограничениями. Для process isolation packet engine нужна отдельная корреляция соединений и жизненного цикла фильтров. Копирование общего `--wf-tcp/udp` этого не реализует.

В существующий ciadpi можно перенести TCP stream splitting/disorder, TLS record fragmentation и поддержанные fake/SNI параметры. Packet sequence overlap, badseq, TCP MD5/timestamp tricks и UDP QUIC/Discord/STUN ветки не имеют полного соответствия обычному app SOCKS TCP шлюзу; [ByeDPI](https://github.com/hufrea/byedpi/blob/main/README.md) дополнительно ограничивает отдельные приёмы платформой, например md5sig Linux. Эффективность TCP стратегии в сети пользователя требует фактической проверки, а не механического переименования опций.

Native Windows tpws не найден в установленном runtime. [Официальные Windows инструкции Zapret](https://github.com/bol-van/zapret/blob/master/docs/windows.md) описывают tpws через WSL, а native winws через WinDivert и административные полномочия. Поэтому новый автономный Relay route состоит из app DoH + имеющегося ciadpi; полный профиль UDP/game/voice Zapret в него не включён. WinDivert binary/driver не копируются в этот gateway.

Лицензии: [ByeDPI MIT](https://github.com/hufrea/byedpi/blob/main/LICENSE), [Zapret MIT](https://github.com/bol-van/zapret/blob/master/docs/LICENSE.txt), [Flowseal MIT](https://github.com/Flowseal/zapret-discord-youtube/blob/main/LICENSE.txt); WinDivert распространяется с выбором LGPLv3/GPLv2 по его документации. Для реально включённых binaries installer должен содержать соответствующие notices/license texts. В Relay уже добавлен `runtime/licenses/BYEDPI-LICENSE.txt`; этот gateway не добавляет WinDivert или tpws. Юридическая комплектность всех остальных артефактов проверяется общим release gate.

## Живой доступ Telegram: нерешённый отказ TCP

После успешных локальных gate выполнена отдельная WAN проверка с bundled Node 24.21.0, ciadpi 17.3 и точно выбранным пользователем personal DoH profile. DPAPI envelope расшифрован только в RAM и передан Node по stdin. URL/token не выводились и не сохранялись. Использовались только собственные процессы и свободные loopback порты; аккаунты, системные службы и сетевые настройки не затрагивались.

Сравнивались три фиксированные стратегии: current `--split 1 --disorder 3+s --mod-http=h,d --tlsrec 1+s`, более простая `--split 1+s --tlsrec 1+s` и ciadpi без desync flags. Общие параметры `-N -U --proto tls,http --pf 80-8443` сохранялись. Приложение автоматически между стратегиями не переключалось; это отдельные последовательные audit процессы.

| Проба | Current | Split only | No desync |
| --- | --- | --- | --- |
| example.com HTTPS | 200, полное тело 713 bytes, 795 мс | 200, полное тело 713 bytes, 513 мс | 200, полное тело 713 bytes, 515 мс |
| web.telegram.org HTTPS, три попытки | Все timeout около 15 с до TLS | Все timeout около 15 с до TLS | Все timeout около 15 с до TLS |
| t.me / telegram.org / api.telegram.org HTTPS | Все timeout до TLS | Все timeout до TLS | Все timeout до TLS |
| Numeric DC1/DC2/DC4 TCP 443 | Все timeout около 15 с | Все timeout около 15 с | Все timeout около 15 с |

Всего 30 probes: 3 успешных control HTTPS и 27 Telegram failures. Safe DNS summary после каждой стратегии: `ready`, пять cache entries. Отдельно проверены DC1 `149.154.175.50`, DC2 `149.154.167.51`, DC4 `149.154.167.91` на TCP 80 и 5222 с deadline 5 секунд — все шесть timeout. Эти дополнительные numeric probes идут через собственный ciadpi SOCKS backend; production gateway по-прежнему не допускает 5222. HTTPS 443 к `pluto.web.telegram.org`, `venus.web.telegram.org`, `aurora.web.telegram.org` через выбранный DoH и gateway также завершился до TLS timeout примерно 5 секунд во всех трёх случаях. Это HTTPS connectivity проверка WSS hosts, без WebSocket upgrade или MTProto authentication.

Во время current numeric DC4 probe таблица TCP Windows показала собственный ciadpi PID 24988 в `SynSent` к `149.154.167.91:443`. Числовой DC запрос не зависит от DNS; до завершения TCP handshake TLS splitting ещё не применяется. Упрощение и отключение desync не исправили наблюдаемый отказ. На основании этих данных не предлагаем менять рабочую TLS стратегию или порт как доказанное исправление Telegram.

Точный источник потери SYN/SYN-ACK не определён: возможны upstream filtering, routing, firewall/VPN/WinDivert или удалённая сторона. Действующий глобальный Lagom WinDivert остаётся внешним фактором; он не отключался ради сравнения. Нельзя приписывать отказ исключительно провайдеру или объявлять результат проверкой на чистой системе. DNS + TCP desync не обеспечивают соединение, если TCP endpoint недоступен. Явный удалённый MTProxy либо другой отдельно выбранный маршрут требует самостоятельного теста; VPN не объявляется обязательным решением и никакой direct/fallback route не включается автоматически.

Все четыре собственных backend PID 24988/48584/40204/15600 завершились после тестов. Reviewable case evidence и hashes сохранены в `AUDIT-1.2.5-NETWORK-CONNECTIVITY.json`; воспроизводимый harness находится в `scripts/regression/network-connectivity.mjs`. Эти результаты не исправлены локальными 84/84 fixtures. Пока Telegram TCP доступ на этой сети остаётся нерешённым, нельзя утверждать, что автономный DoH/DPI режим полноценно готов для Telegram на данном ПК.

Сводка с названиями случаев, source SHA-256 и путями исходного evidence: `AUDIT-1.2.5-NETWORK-EVIDENCE.json`. Полные журналы остаются в task work. Production bridge bundle, нативный executable и установщик требуют отдельной проверки после сборки; исходниковая матрица не подменяет этот release gate.

Контракты framing сверены по [Telegram MTProto transports](https://core.telegram.org/mtproto/mtproto-transports). Владение socket проверяется по [GetExtendedTcpTable](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable), [IPv6 owner row](https://learn.microsoft.com/en-us/windows/win32/api/tcpmib/ns-tcpmib-mib_tcp6row_owner_pid) и [IsProcessInJob](https://learn.microsoft.com/en-us/windows/win32/api/jobapi/nf-jobapi-isprocessinjob).

## Оставшиеся ограничения и план

1. **Проверка собранного релиза:** подтвердить новые default ports, фактическую связь main/X/Instagram/media с выбранным app route, остановку и восстановление каждого собственного helper, отсутствие вмешательства в уже работающие приложения. Это обязательный gate общего релиза.
2. **Сеть и VPN:** длительная работа, сон/пробуждение, физическая смена сети, отключение и подключение конкретных VPN требуют живой матрицы на поддерживаемых конфигурациях. Локальные фикстуры и отсутствие записи сетевых настроек такой матрицы не заменяют.
3. **Автономный DNS/DPI на собранном приложении:** подтвердить общий WebView/Telegram/media маршрут, фактический private DoH, отказ без direct fallback, backend `-N -U`, updater/Chromium DNS и работу на втором ПК без Lagom. Живые проверки на текущем ПК с действующим глобальным WinDivert не доказывают эффективность ciadpi в одиночку. Опциональное Xray шифрование требует отдельного gate при явном включении.
4. **Неполные HTTP/1.1-ответы:** ранее отмеченные короткие ответы `ciadpi` не считаются исправленными этим изменением — binary helper не заменён. Проверка полного тела и корректный отказ download необходимы; общий media-аудит отвечает за этот gate.
5. **Восстановление UI:** перезапуск proxy может отменить выполняющуюся загрузку и перезагрузить созданные social WebView. Сохранение незавершённых форм сторонних сайтов и продолжение transfer после закрытия приложения не подтверждены.
6. **Нагрузочные пределы:** проверены локальные byte/order fixtures и bounded buffers, а не часы работы под 128 активными тяжёлыми сессиями, многогигабайтные файлы или все CDN/регионы. Из результатов не выводится обещание «всегда работает» или численное ускорение.
7. **Динамические Telegram endpoints:** передавать в bridge проверенные официальные `dc_options` и CDN endpoints из клиента. До этого фиксированная bootstrap-матрица требует отдельной проверки настоящих Telegram загрузок, особенно CDN и региональных изменений адресов.
