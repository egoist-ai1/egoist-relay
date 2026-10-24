# Проверка движка Xray для Egoist Relay 1.2.5

Дата: 29 сентября 2026. Проверка отдельного движка; установщик, реальный выбранный профиль и UI проверяет основной агент.

## Выбранный кандидат

Собран чистый официальный исходник Xray commit **47cfe9994a6b39b1f673ba35e62b091bcce15a71** от 8 сентября 2026 с официальным **Go 1.26.8 / Windows amd64**. Изменений исходника, go.mod и go.sum нет. Это сборка из конкретного commit, **не объявленный upstream stable release**. Внутренняя версия исходника ещё 26.7.28; строка бинарника:

~~~
Xray 26.7.28 (Xray, Penetrates Everything.) 47cfe999-relay-go1.26.8 (go1.26.8 windows/amd64)
~~~

Этот commit — непосредственный parent изменения fd2ca7482211cd0185763caa4961ab7d6780918f, которое требует Go 1.27. Git merge-base подтвердил наличие исправлений #6665 и #6694 в его ancestry. Источник: [commit движка](https://github.com/XTLS/Xray-core/commit/47cfe9994a6b39b1f673ba35e62b091bcce15a71), [следующий переход Go](https://github.com/XTLS/Xray-core/commit/fd2ca7482211cd0185763caa4961ab7d6780918f), [его go.mod](https://github.com/XTLS/Xray-core/blob/47cfe9994a6b39b1f673ba35e62b091bcce15a71/go.mod).

GitHub не подтверждает подпись выбранного commit: verification=false, reason=unsigned. Происхождение проверено по официальному HTTPS repository, полному Git SHA и ancestry. Бинарник сборки не подписан Authenticode.

### Контрольные суммы

| Файл | SHA256 |
|---|---|
| xray.exe | 8965a30c44ce8f2df4cc5aa5deac790c767066c31a1ffc218d49923862f3f55c |
| Повторная сборка | 8965a30c44ce8f2df4cc5aa5deac790c767066c31a1ffc218d49923862f3f55c |
| Xray-core-47cfe999-source.zip | e13eaf674c6f6ec25e2ebd18864bf0c0428a91235eb77b52b47a44dbc281db58 |
| go1.26.8.windows-amd64.zip | b92c3b2adae85a11ba71fe7216daf0d84e82af4c8ab6c5625807f28622043a59 |
| manifest.json | 9e2c785894bcaba60b2dde5c80578109cdd6421015be1f7957994ff0c9dcbf59 |

Размер xray.exe: 37 259 776 байт. Архив Go сверялся с официальным [download API](https://go.dev/dl/?mode=json&include=all). Go 1.26.8 опубликован 1 сентября 2026; содержит предыдущие исправления ветки 1.26. [История Go](https://go.dev/doc/devel/release)

Staging: releaseengine-source/xray-47cfe999-go1.26.8. Рядом находятся исходник, build script, MPL/Go notices, 51 файл лицензий/notice импортируемых модулей, dependencies.json и evidence. Производственный runtime этим агентом не заменялся.

## Почему не автоматический переход на 26.9.9

GitHub на момент проверки публикует 26.9.9 как pre-release; 26.5.3 и 26.7.28 тоже отмечены pre-release. Сам ярлык не доказывает качество или ухудшение. Более позднего официального тега на Go 1.26 между 26.7.28 и 26.9.8 нет: tags API и 404 для предполагаемых 26.9.5/26.9.7 проверены. [Теги](https://github.com/XTLS/Xray-core/tags)

Открытый vendor-repository [issue #6797](https://github.com/XTLS/Xray-core/issues/6797) сообщает рост TCP-соединений и памяти при зависших TLS handshake в **stream-one + HTTP/2** у сборок Go 1.27 / Xray 26.9.8–26.9.9. Это пользовательское воспроизведение в repository проекта. Оно не воспроизведено здесь на 26.9.9, Windows или реальном профиле Relay. Наш выбранный профиль — **stream-up**; его affected status по этому issue не установлен.

Исходник используемого golang.org/x/net/http2 разделяет старый и оборачивающий net/http transport build conditions по go1.27 и http2legacy. Сборка Go 1.26.8 использует прежний путь. Это причина исключить конкретный новый механизм из кандидата, а не утверждение, что latest не работает у пользователя.

Июльский 26.7.28 + Go 1.26.8 сначала был собран дважды для сравнения, но не принят для релиза: в нём отсутствуют поздние исправления XHTTP. [#6665](https://github.com/XTLS/Xray-core/pull/6665) исправляет гонки записи и closed; [#6694](https://github.com/XTLS/Xray-core/pull/6694) исправляет публикацию интерфейса WaitReadCloser, где Read/Close могли получить частично записанный интерфейс. WaitReadCloser используется и stream-up/down. Эти исходные пути проверены; отдельного воспроизведения старого падения под Go race detector здесь нет.

Выбранный pre-Go1.27 commit содержит оба исправления и [#6095](https://github.com/XTLS/Xray-core/pull/6095), закрывающий body при ошибках stream-up/one. Таким образом, выбор не останавливается на старом теге с известными отсутствующими исправлениями.

## Совместимость профиля

Синтетические конфиги создавались производственным scripts/lagom-tunnel.mjs. Все варианты auto, packet-up, stream-up, stream-one для REALITY и строгого TLS приняты xray run -test -config stdin:.

У Relay задан один SOCKS inbound на 127.0.0.1 и один VLESS outbound, security=REALITY или strict TLS, transport=xhttp. Настройки serverName, fingerprint, publicKey, shortId, spiderX и используемые XMUX-поля сохранены. publicKey продолжает приниматься как alias password. Переименование необязательных session-полей XHTTP не влияет: Relay их не задаёт.

Новый default maxConnections=3 применяется только при полностью пустом XMUX. Явно заданные параметры Relay не получают это значение автоматически. Источник: [конфигурация transport](https://github.com/XTLS/Xray-core/blob/47cfe9994a6b39b1f673ba35e62b091bcce15a71/infra/conf/transport_method.go), [REALITY config](https://github.com/XTLS/Xray-core/blob/47cfe9994a6b39b1f673ba35e62b091bcce15a71/infra/conf/transport_security.go).

## Проверки безопасности: применимость

Сводка относится к разрешённому профилю Relay, а не ко всем возможным режимам Xray.

| Advisory / дефект | Применимость к старому маршруту | Кандидат |
|---|---|---|
| GHSA-5wf9-h793-w73c: CA pinning при пустом ServerName, Hy2/gRPC | Условие не задано: Relay запрещает pinnedPeerCertSha256 и эти транспорты, требует DNS serverName. XHTTP TLS вызывает GetTLSConfig(WithDestination); REALITY использует отдельный UClient. | Июльское исправление проверки имени включено. Не выдаётся за доказанный старый MITM Relay. |
| GO-2026-5037 / CVE-2026-27145: стоимость VerifyHostname на длинных SAN | Go 1.26.2 входит в диапазон. REALITY fallback проверки сертификата вызывает стандартный x509.Certificate.Verify; функция достижима. Вредоносный вход / exploit на установленном Relay не проверялся. | Исправление Go 1.26.4 включено в 1.26.8. |
| GO-2026-4918 / CVE-2026-33814: HTTP/2 SETTINGS loop | Стандартная библиотека Go 1.26.2 совпадает по версии, однако XHTTP использует x/net/http2; старый официальный Xray 26.5.3 уже фиксирует x/net 0.53.0, исправленную версию этого дефекта. | x/net 0.58.0 и Go 1.26.8. Нельзя назвать старый XHTTP установленно уязвимым по одной версии Go. |
| GO-2026-5856: ECH/PSK privacy; GO-2026-6090: KeyUpdate DoS | Первое требует ECH/PSK, второе описывает TLS server с атакующим client. Relay не включает ECH и TLS server; REALITY отключает session tickets. | Исправления стандартной библиотеки включены. uTLS — отдельный fork: обновление Go само по себе не обновляет его код. |
| GO-2026-5026: IDNA ASCII-only punycode | Старый x/net 0.53.0 совпадает с affected range. Входные hostname профиля фиксированы и валидируются; условие обхода host privilege checks у Relay не показано. | x/net 0.58.0 включает исправление 0.55.0. |

Первоисточники: [Xray GHSA](https://github.com/XTLS/Xray-core/security/advisories/GHSA-5wf9-h793-w73c), [REALITY verification](https://github.com/XTLS/Xray-core/blob/47cfe9994a6b39b1f673ba35e62b091bcce15a71/transport/internet/reality/reality.go), [XHTTP dialer](https://github.com/XTLS/Xray-core/blob/47cfe9994a6b39b1f673ba35e62b091bcce15a71/transport/internet/splithttp/dialer.go), [GO-2026-5037](https://pkg.go.dev/vuln/GO-2026-5037), [GO-2026-4918](https://pkg.go.dev/vuln/GO-2026-4918), [GO-2026-5856](https://pkg.go.dev/vuln/GO-2026-5856), [GO-2026-6090](https://pkg.go.dev/vuln/GO-2026-6090), [GO-2026-5026](https://pkg.go.dev/vuln/GO-2026-5026).

### Четыре предупреждения govulncheck сохранены

govulncheck v1.8.0, база https://vuln.go.dev от 28 сентября 2026, проверены source ./main и собранный бинарник.

| Advisory | Зависимость | Binary result | Source / import inventory |
|---|---|---|---|
| GO-2026-5841 | klauspost/compress 1.17.4, s2.NewDict; fixed 1.18.7 | Есть inferred records | Только module warning; s2 не импортируется |
| GO-2026-5932 | x/crypto 0.55.0, unmaintained OpenPGP | Есть inferred records | Только module warning; OpenPGP packages не импортируются |
| GO-2026-6354 | x/crypto 0.55.0, SSH DoS; fixed 0.56.0 | Есть inferred records | Только module warning; ssh не импортируется |
| GO-2026-6355 | x/crypto 0.55.0, SSH DoS; fixed 0.56.0 | Есть inferred records | Только module warning; ssh не импортируется |

В binary JSON — 39 finding records для четырёх advisory. В source JSON — четыре module-level records, **0 affected package/symbol traces**. go list -deps подтверждает отсутствие указанных пакетов в графе сборки ./main; compress используется через zstd/fse/huff0 и связанные packages.

Код сканера для stripped executable консервативно использует все известные уязвимые symbols из модулей, когда PkgSymbols пуст. Проверка govulncheck -mode=extract именно этого SHA дала **PkgSymbols=0**; evidence/scanner-extract-summary.json сохраняет результат. Бинарник собран с -s -w. Это подтверждает fallback сканера: перечисленные binary functions являются inferred records, а не наблюдавшимися compiled functions. Их не удаляли из evidence и не называют нулём предупреждений. [Код сканера v1.8.0](https://cs.opensource.google/go/x/vuln/+/refs/tags/v1.8.0:internal/vulncheck/binary.go), [описание govulncheck](https://go.dev/doc/security/vuln/)

Это не доказательство отсутствия всех уязвимостей: неизвестные дефекты, runtime-условия, fork uTLS и точность анализа имеют ограничения. Зависимости не патчились неявно.

## Сборка и тесты

Все SDK, инструменты, GOPATH, GOMODCACHE, GOCACHE и GOTMPDIR находились в каталоге этой задачи. GOTOOLCHAIN=local, GOENV=off, CGO_ENABLED=0, GOAMD64=v1. go mod verify завершён с all modules verified. Загрузка официальных Go/module URL шла через специально предоставленный root SOCKS и собственный loopback CONNECT adapter; сетевые настройки Windows, Lagom и VPN не менялись.

Флаги основаны на официальном workflow:

~~~
go build -p=2 -trimpath -buildvcs=false -gcflags=all=-l=4 \
  '-ldflags=-X github.com/xtls/xray-core/core.build=47cfe999-relay-go1.26.8 -s -w -buildid=' \
  -o xray.exe ./main
~~~

Две сборки дали одинаковый SHA256. Это воспроизводимость на одном host с одинаковыми clean inputs и общим изолированным module/compiler cache; независимые машины и полностью холодные повторные caches не проверялись. Build-time GOMAXPROCS=2 не устанавливает runtime CPU priority или лимит приложения.

| Проверка | Результат |
|---|---|
| Официальные loopback XHTTP TCP/TLS/H2C tests | 4 PASS |
| Официальные TLS certificate/pinning tests | 7 PASS |
| Schema REALITY/TLS × четыре XHTTP mode | 8 PASS |
| Synthetic handshake stall, 128 sessions × четыре конфигурации | 4 PASS |
| Ошибки этих кандидатных gates | 0 |

### Bounded stall gate и XMUX

Blackhole слушал только собственный loopback порт и принимал TCP, не отвечая на handshake. SOCKS destination был числовым; единственный outbound у synthetic fixture вел в этот blackhole. Частный профиль и аккаунты не использовались.

| Режим | XMUX | Открыто sessions | Наблюдавшийся peak pending TCP | Private memory под нагрузкой |
|---|---|---:|---:|---:|
| TLS stream-one | maxConnections=2, maxConcurrency=0 | 128 | 2 | 64 110 592 B |
| TLS stream-up | maxConnections=2, maxConcurrency=0 | 128 | 2 | 64 475 136 B |
| REALITY stream-up | maxConnections=2, maxConcurrency=0 | 128 | 2 | 64 483 328 B |
| REALITY stream-up | maxConnections=0, maxConcurrency=4 | 128 | 31 | 66 867 200 B |

maxConnections и maxConcurrency не могут быть одновременно положительными: parser отвергает это. Поддерживаемый вариант для ограничения XMUX pool — **2 / 0**. Больше streams делят два HTTP/2 client; это может добавить очередь, уменьшить burst throughput и увеличить число streams, зависящих от одной TCP-потери.

maxConnections ограничивает XMUX client pool, а не абсолютно все TCP. HTTP/2 server stream limits, GOAWAY и замена старого XMUX при активных streams могут создать дополнительные соединения. Поэтому «всегда максимум два TCP» не гарантируется этим параметром. [XMUX pool implementation](https://github.com/XTLS/Xray-core/blob/47cfe9994a6b39b1f673ba35e62b091bcce15a71/transport/internet/splithttp/mux.go)

Матрица длится ограниченное время и не заменяет многодневный soak, тест outage/rotation реального сервера, bandwidth fairness и race detector. Измерения описывают собственный Windows fixture, а не vendor Linux reproduction.

Все четыре fixture Xray завершены; собственный CONNECT adapter PID 31964 остановлен после проверки command line. Readback: listener 58853 = 0, процессов выбранного fixture executable = 0. Чужие процессы не останавливались.

## Перед установщиком

Основной агент проверяет именно staged SHA на выбранном профиле: Telegram/X/Instagram/public control, DNS, прекращение собственного backend без direct fallback и восстановление, затем собирает личный установщик. Этот документ не заменяет тот gate и не утверждает завершение публичной оценки продукта.

