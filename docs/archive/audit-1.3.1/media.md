# Media transport audit — 1.3.1

Дата: 30 сентября 2026 года. Область: Node media transport, CDN fetch, публичный media resolver и их регрессионные тесты. UI, Rust выбор системного proxy, установщик и реальные аккаунты проверяются отдельно.

## Контракт маршрута

Rust передаёт для каждой операции `EGOIST_RELAY_MEDIA_PROXY`: адрес выбранного системного proxy либо точное значение `direct`. Node не читает Windows registry и не выбирает свой VPN, DNS, DPI backend или системный proxy.

| Значение | Поведение |
| --- | --- |
| `direct` | Обычный TCP маршрут ОС; Node CDN использует системный DNS и проверяет ответы; yt-dlp получает явное `--proxy ''` |
| HTTP / HTTPS proxy URL | CONNECT до разрешённого media hostname:443; HTTPS proxy дополнительно проверяет свой TLS сертификат |
| SOCKS / SOCKS5 / SOCKS5h proxy URL | SOCKS5 CONNECT с hostname; разрешение адреса назначения выполняет выбранный proxy |
| Отсутствует, пустое или некорректное значение | `MEDIA_PROXY_DENIED` до начала media transport |
| Выбранный proxy недоступен или отклоняет CONNECT | `MEDIA_PROXY_FAILED`; автоматического direct перехода нет |

Поле IPC `proxyPort` остаётся допустимым необязательным legacy полем с проверкой диапазона. Оно не выбирает маршрут и не заменяет `direct` или proxy URL. Rust может удалить это поле.

## Подтверждённые проблемы и выполненные изменения

### P1: обязательный внутренний proxy несовместим с системным маршрутом

В исходном коде `parseMediaProxy(value, fallbackPort)` выбирал `socks5://127.0.0.1:<fallbackPort>`, когда env отсутствовал. `direct` отклонялся. Оба worker требовали `proxyPort`; resolver всегда создавал SOCKS gate. Это делало media dependent на отдельный локальный backend.

Сейчас `scripts/media-proxy.mjs:8` принимает только явный маршрут; `scripts/social-media-fetch.mjs:37` и `scripts/inline-media-resolver.mjs:180` не требуют proxyPort. Direct CDN соединяется с hostname:443 через системный маршрут. Direct resolver не открывает gate. В proxy режиме gate ограничивает назначения существующим списком host каждого сервиса и использует только переданный системный proxy.

Evidence: успешные native HTTPS GET по HTTP/1.1 и HTTP/2 в direct режиме; успешные GET через HTTP CONNECT и SOCKS5; старый proxyPort не влияет на direct; отсутствующий/некорректный env не вызывает транспорт; proxy 407 не вызывает ни direct connector, ни локальный DNS назначения.

### P1: расширение встроенного worker превысило лимит Windows command line

Первый свежий прогон воспроизвёл `spawn ENAMETOOLONG` при старом способе запуска: percent encoded helper в data URI плюс resolver в `node -e`. Исходный лог сохранён в task work. Parent реализовал Rust запуск из принадлежащего операции каталога: `media-proxy.mjs` и исходный файл выбранного worker (`inline-media-resolver.mjs` либо `social-media-fetch.mjs`); JSON передаётся через stdin. Это подтверждено чтением текущих Rust call sites, native build проверяется отдельно.

Регрессия `File-backed Node workers load the exact proxy module and reject invalid IPC input` использует точные актуальные исходники, запускает `node <workerPath>`, передаёт JSON через stdin и проверяет `MEDIA_INPUT_DENIED` для обоих worker. Это проверяет загрузку модулей и IPC отказ; владение каталогом, его права и cleanup Rust проверяются parent отдельно.

### P2: direct должен явно исключать ambient proxy настройки yt-dlp

`scripts/inline-media-resolver.mjs:81` передаёт одинаковую выбранную route в metadata и download. В direct режиме аргумент `--proxy` имеет пустое значение. Engine environment удаляет HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY и остальные proxy overrides вместе с опасными runtime/TLS overrides. Это предотвращает самостоятельный выбор другого proxy engine.

Evidence: синтетический spawn проверяет обе фазы, пустой аргумент direct и очищенный env. Отдельная resolver регрессия выполняет реальный SOCKS handshake к gate для обеих фаз и наблюдает два CONNECT к выбранному HTTP proxy; route обеих фаз совпадает.

## Сохранённые границы

- Node CDN: HTTPS, provider host allowlist, порт 443, запрет userinfo и fragment; каждый redirect повторно проходит проверку; максимум три redirect.
- Direct Node CDN: DNS отвечает системный resolver; все ответы должны быть публичными IP, иметь корректную family, число ответов ограничено 32. Проверенные адреса передаются непосредственно в TCP lookup callback, повторного DNS разрешения после проверки нет.
- Private, loopback, link-local, CGNAT, multicast, documentation, IPv4 mapped и IPv6 transition диапазоны отклоняются `MEDIA_ADDRESS_DENIED`. Mixed public/private DNS ответы также отклоняются.
- Проверка TLS сертификата и hostname включена. Test CA добавляется исключительно через test transport override; IPC такой настройки не содержит.
- HTTP/1.1 и HTTP/2 используют один уже выбранный TLS socket. Ветвь HTTP/1.1 создаёт собственный Agent, ветвь HTTP/2 — собственный client; media URL повторно через ambient proxy не отправляется.
- Native fetch: максимум 64 MiB, 60 секунд общий deadline, проверка Content-Length/полноты тела и signature формата. Resolver: 120 секунд, 64 MiB, длительность до 600 секунд, ограниченные extractor и local ffmpeg protocol whitelist `file,pipe`.
- Abort закрывает соединение в pending proxy handshake и pending direct DNS lookup. Закрытие resolver операции закрывает gate и его sockets. Cleanup временных cookies и частичных media файлов проверяется существующими тестами.
- Классификация bot / geo / auth / rate limit / HTTP forbidden сохранена. Маршрут не устраняет ограничения сервиса.

## Результаты проверки

Команда: `node --test scripts/media-proxy.test.mjs scripts/social-media-fetch.test.mjs` с task-local `EGOIST_RELAY_AUDIT_WORK`.

| Проверка | Результат |
| --- | --- |
| Node media / proxy tests | 51 passed, 0 failed, 0 skipped |
| Scoped ESLint для пяти изменённых scripts/tests | Exit 0 |
| `git diff --check` для scope | Exit 0; scripts пока untracked, поэтому substantive проверку обеспечивает ESLint и запуск tests |

Native transport fixtures реально выполняют TCP, TLS и HTTP/1.1 / HTTP/2 на loopback. Системный DNS подменяется публичным синтетическим ответом, а test connector отображает проверенный адрес на локальный TLS fixture. Никаких запросов к пользовательским аккаунтам, реальным CDN, системных настроек или VPN служб не выполнялось.

Логи в собственном task work:

- `media-1.3.1-node-tests-first.log`: 45/47, включая воспроизведение Windows command line overflow; второй отказ был чрезмерно строгим ожиданием стандартного HTTP/2 authority `:443` в fixture.
- `media-1.3.1-node-tests.log`: финальные 51/51.
- `media-1.3.1-eslint.log`: scoped lint без ошибок.

## Ограничения и оставшиеся проверки

1. Node CDN direct отклоняет VPN fake-IP DNS, например `198.18.0.0/15`. Это намеренная граница адресов; настройка Windows/Lagom должна возвращать публичные адреса либо выбрать системный proxy. Автоматического ослабления SSRF проверки нет.
2. yt-dlp в direct режиме самостоятельно обрабатывает извлечённые CDN адреса и redirects. Canonical source URL и extractor ограничения сохранены; host / port allowlist локального gate действует только в proxy режиме. Gate не проверяет direct engine DNS и перенаправления. Полное равенство этих политик не заявляется.
3. HTTPS proxy не поддерживает userinfo credentials; parse также отклоняет пути/query. Proxy с проверяемым сертификатом поддерживается; реальная корпоративная/персональная proxy аутентификация не проверялась.
4. Системный proxy выбирается на стороне Rust до запуска операции. Изменение системной route во время уже идущей операции не переводит её автоматически на новый proxy. Следующая операция получает новое решение Rust.
5. Эти tests доказывают маршрутизацию и локальные ограничения worker, но не доступность YouTube / X / Instagram на другом ПК, отсутствие bot challenge или корректность PAC / WinHTTP выбора. Установленная сборка, Rust job lifecycle и payload требуют интеграционной проверки parent.

Файлы scope готовы к интеграции и заморожены после review: `media-proxy.mjs`, `inline-media-resolver.mjs`, `social-media-fetch.mjs` и два соответствующих test файла. Новых зависимостей нет.
