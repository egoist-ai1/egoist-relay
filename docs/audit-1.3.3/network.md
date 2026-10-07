# Relay 1.3.3: Lagom без VPN

Действующий режим по запросу владельца: SystemDoH, Zapret TCP/UDP и локальный TelegramProxy Lagom. VPN не требуется и не предлагается. Этот отчёт заменяет рекомендацию подключения VPN в сетевом отчёте 1.3.2. Ниже сохранены результаты сетевого аудита и отдельно зафиксировано разрешённое владельцем применение.

## Проверенный маршрут

На 30.09.2026, 20:03, Москва, Core, SystemDoH, TelegramProxy и Zapret работают. Единственный активный физический адаптер использует IPv4 DNS `127.0.0.1`; Windows user HTTP proxy выключен, ручного endpoint и явного PAC нет. `DIRECT` здесь совместим с прозрачной обработкой DNS/DPI и не является признаком неисправного прокси.

В действующем `general (EGOIST MIX)` пользовательский `C:\ProgramData\EgoistShield\Runtime\Zapret\core\lists\list-general-user.txt` уже подключён к стратегиям TCP 80/443 и UDP 443. Это подтверждено service definition и исходником Lagom `src/zapret/general (EGOIST MIX).bat:17`, `:22`. Существующие domain/IP exclude lists остаются частью этих стратегий. В исходном snapshot ни hostlists, ни текущие включённые CIDR не охватывали 19 проверенных социальных endpoints; YouTube совпал с отдельной TCP 443 стратегией.

Исторические публичные probes 18:29, без аккаунтов/cookies: все пять `zws1`…`zws5.web.telegram.org:443` завершились TCP timeout примерно через 7,1 с; `www.instagram.com` и `www.facebook.com` получили TLS reset 10054; `x.com/i/flow/login` ответил HTTPS HEAD 307, YouTube — 200. Это отказы до логина, а не доказательство неправильных credentials. Они не определяют конкретного фильтрующего оператора. Новая маршрутизация требует повторной проверки собственно Relay.

## Минимальное изменение списка

Подготовлен [apply-lagom-social-domains.ps1](<C:/Users/Egoist/Desktop/Проекты/Приложения/Egoist Relay/scripts/apply-lagom-social-domains.ps1>). Он добавляет только отсутствующие публичные семейства:

```text
telegram.org
t.me
x.com
twitter.com
twimg.com
instagram.com
cdninstagram.com
fbcdn.net
facebook.com
facebook.net
```

Имена пишутся без `*.`. Корневое имя охватывает поддомены; доменные исключения имеют приоритет. Это семантика установленной версии [Zapret, hostlist.c](https://raw.githubusercontent.com/bol-van/zapret/c849e55ef0f1c244206f5a05ff7b1ab41a3824ee/nfq/hostlist.c). Семейства включают проверенные `web.telegram.org`, `zws*`, `t.me`, `api.x.com`, `api.twitter.com`, `pbs/video.twimg.com`, `www/i/graph.instagram.com`, `static.cdninstagram.com`, `www.facebook.com` и `connect.facebook.net`; полный список всех CDN этим не заявляется.

По умолчанию помощник возвращает только JSON-план. `-Apply` требует уже административного процесса. Он проверяет фиксированный путь, принадлежность SCM/профиля EGOIST MIX, обе TCP/UDP ссылки на этот user list, сохранение domain excludes, владельца Administrators/SYSTEM, reparse points и предел 1 MiB на файл. Исходный файл остаётся неизменным байтовым префиксом: комментарии, регистр, порядок, BOM, кодировка и существующие окончания строк сохраняются. UTF-8 и совместимые восьмибитные списки поддерживаются; UTF-16/32, NUL и повреждённый UTF-8 с BOM отклоняются без записи, поскольку winws читает byte-oriented hostlists.

Перед заменой повторно проверяются хеши XML, target и domain exclusions, а также SDDL target. Новый файл создаётся через `CreateNew` в той же директории, синхронизируется и заменяет target через [File.Replace](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.replace?view=netframework-4.8.1) с проверкой ошибок переноса metadata. После записи проверяются ожидаемый SHA256 и сохранённый SDDL; собственный TEMP удаляется в `finally`. ACL не переопределяется. Между последним hash check и заменой остаётся небольшой интервал: это обнаружение конкурентной правки, а не транзакционная блокировка приложения. При ошибке с `mayHaveApplied=true` требуется readback перед повтором.

Помощник не читает VPN/Telegram credentials, не меняет DNS, proxy, службы, `.bat`, XML, другие списки или сетевые движки. Семейства, целиком исключённые текущим domain exclude, не добавляются; частичные доменные исключения отображаются в плане и продолжают действовать. IP exclusions остаются действующими и не переписываются.

## Применение без перезапуска

Установленный `core/bin/winws.exe` имеет 203 776 байт и SHA256 `affb4f69d2ea302a7abccd5325d81826e140ddae014f1e070bc4a6c0dd555188`. Он побайтно совпал с [официальным binary Flowseal tag 1.10.3](https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/1.10.3/bin/winws.exe). Из статических строк прочитаны версия `v72.9` и commit `c849e55ef0f1c244206f5a05ff7b1ab41a3824ee`; файл не запускался для проверки. Это привязка к установленному payload, не чтение памяти работающего процесса.

В этом конкретном commit `LoadHostList`/`HostlistsReloadCheck` перечитывают изменённый файл перед hostlist decision, а `file_mod_signature` сравнивает `mtime` и размер ([hostlist.c](https://raw.githubusercontent.com/bol-van/zapret/c849e55ef0f1c244206f5a05ff7b1ab41a3824ee/nfq/hostlist.c), [helpers.c:357](https://raw.githubusercontent.com/bol-van/zapret/c849e55ef0f1c244206f5a05ff7b1ab41a3824ee/nfq/helpers.c)). [Документация этой версии](https://raw.githubusercontent.com/bol-van/zapret/c849e55ef0f1c244206f5a05ff7b1ab41a3824ee/docs/readme.en.md) также подтверждает автоматическое обновление по времени или размеру. Добавление увеличивает размер; для list-only операции перезапуск не требуется. Проверять следует новые соединения, поскольку существующий stream не обязан пересчитаться.

Штатная альтернатива внутри Lagom — «Сохранить и применить», `window.egoistAPI.zapret.getUserLists()` / `saveUserLists(lists)` (`src/recovered/preload.cjs:152`). Обязательны все четыре массива: `generalDomains`, `includedCidrs`, `excludedDomains`, `excludedCidrs`; три остальных следует сохранить. В source `zapret-manager.js:820` сохраняются списки, затем `reapplyAfterUserListsChange:2192` применяет профиль; при неизменных XML/имени `setServiceProfile:886` возвращает status без restart. Эта логика обнаружена и в установленном `component-worker.cjs`. Core mutation принимает установленный Lagom client; готовой внешней list-save CLI или адресованного Lagom connector в сессии нет. Подготовленный файловый помощник — ограниченная административная maintenance-операция, а не обход named-pipe авторизации.

## Проверка помощника

Замороженный SHA256 source: `95bc816c19eddf98ab34fb887c338c66135ae5d5fdb3318ea33df62ebc3dadf3`, размер 14 270 байт. Windows PowerShell 5.1 parser и PSScriptAnalyzer: без замечаний. Девять проверок на временных файлах задачи прошли: UTF-8 без конечного newline, BOM, восьмибитные комментарии, strict/suffix match, excludes, отказ wide encoding, same-directory replace с исходным byte prefix и SDDL, отказ при изменении snapshot, предел чтения 1 MiB. На живом runtime выполнен только read-only план и проверен отказ `ADMIN_REQUIRED` из неадминистративного процесса.

Read-only план: 18 → 131 байт, десять добавлений, пересекающихся whole/partial domain exclusions нет. Исходный SHA256 `45e4052cfa42f8f81d645bf78d64d6e03f6aea547e471e198ce5f1f7cbc6c541` сохранился после проверки; Zapret остался Running, собственных TEMP в ProgramData нет.

## Применение и проверка установленного Relay

Владелец явно разрешил открыть UAC и применить подготовленную правку. Помощник выполнен с правами администратора и вернул `status=applied`; readback совпал с ожидаемым SHA256 `9ac5c2ba3e7027d1e911927f7c2ffd4954c1d568af7b569c7e01c9a1a03f2786`. SDDL и исходные записи сохранены, десять семейств добавлены, перезапуска служб не выполнялось.

После применения публичные запросы к Instagram и Facebook получили HTTP 200; X перенаправил на действующий onboarding, завершившийся HTTP 200. Проверка Node-запроса к корню abs.twimg.com была нестабильной и не подтверждает загрузку всех CDN. В нативном Relay 1.3.3 отдельный профиль показал настоящий Telegram QR и экраны входа X/Instagram без зарегистрированных ошибок JavaScript. Установленная версия загрузила текущие профили Telegram, X и Instagram; X потребовал обычного обновления страницы после начальных ChunkLoadError. Подробности и ограничения: [интеграционный отчёт](../AUDIT-1.3.3.md) и [verification.json](../../release/1.3.3/verification.json).

## Telegram и будущие defaults

Обычная TLS/QUIC hostlist не превращает локальный MTProxy `tg-ws-proxy` в браузерный WSS или HTTP/SOCKS proxy. Нативный адаптер Relay 1.3.3 выполняет необходимое преобразование транспорта; [его проверка](telegram.md) и интеграционный отчёт подтверждают соединение через существующий TelegramProxy. Наличие `tg://proxy` и Running listener само по себе не переводит `new WebSocket(..., 'binary')` на MTProxy. Увеличение timeout и подмена Telegram hostname не заменяют это преобразование.

Возможный будущий default patch — добавить тот же `--hostlist-domains=...` в два general TCP/UDP блока `src/zapret/general (EGOIST MIX).bat:17`, `:22`; текущий `scripts/prepare-components.mjs:120` уже копирует этот `.bat`. В действующую установку это автоматически не попадёт: `zapret-manager.js:1977` копирует custom профиль только при отсутствии destination, а новый wrapper command потребует managed reapply. Defaults не менялись. В установленном EGOIST MIX применено добавление в пользовательский список, runtime сохранён.
