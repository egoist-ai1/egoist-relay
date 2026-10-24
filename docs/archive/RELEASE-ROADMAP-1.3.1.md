# Egoist Relay 1.3.1 — оставшиеся gates и план доводки

Дата: 30 сентября 2026. Основание: [итоговый аудит](AUDIT-1.3.1.md) и [протокол конкретной сборки](../release/1.3.1/verification.json). Исправления и пересборка текущего scope выполнены. Ниже — работы, для которых фактических результатов пока нет; они не объявляются завершёнными.

## Приоритет и приёмка

| Приоритет | Работа | Критерий закрытия | Зависимость |
| --- | --- | --- | --- |
| P0: публикация | Полная corresponding source delivery поставляемых компонентов | Exact version/hash sources, dependency sources и build recipes FFmpeg/standalone; полный inventory npm/Cargo; проверенные notices и artifact source gate PASS | Нужны исходники точной сторонней сборки или воспроизводимая замена существующего binary |
| P1: доступность | Telegram и Instagram на работающем внешнем маршруте | ОС/Lagom выбирает доступный proxy/TUN; successful bootstrap/login и чтение/медиа без Relay engine; current failures зафиксированы до и после | Внешняя конфигурация и доступ сервиса; Relay не управляет Lagom |
| P1: независимая установка | Чистый второй Windows ПК | Полный production installer install/start/uninstall, offline WebView provisioning, Unicode/default/max path; owner-independent evidence | Второе устройство или VM; не использует владельческие credentials автоматически |
| P1: эксплуатация | 24 h soak, сон/пробуждение и сетевые смены | Нет непойманных аварий; bounded worker cleanup; измерены reconnect time/error rate, CPU/RSS/handles; объяснимые external failures | Работающий внешний маршрут и устройство для длительного наблюдения |
| P1: настоящие функции | Реальные аккаунты и медиа | Read-only login/session/media проверки; отдельно разрешённые операции отправки/добавления/публикации с terminal server result | Авторизация на конкретные account mutations; синтетические тесты не дают её автоматически |
| P2: интерфейс | Native DPI/monitors и реальные sticker formats | 100/125/150/200% Windows scale, monitor changes; TGS/WebM/premium/emoji, time/reactions/avatars без overlap; keyboard и accessible names | Реальные native windows и fixtures |
| P2: transport | PAC/WPAD/proxy auth/fake-IP policies | Ошибки policy не превращаются в hidden direct; измерен total resolver deadline; подтверждена работа supported proxy forms | Изолированные Windows network fixtures |
| P2: dependencies | Остаточные Rust maintenance warnings и upstream frame guard | Совместимое upstream обновление или проверенный bounded patch; отсутствие blanket ignores; полный regression gate | Изменения существующей dependency stack |
| P3: выпуск | Подписанный канал/обновление, когда он понадобится | Проверяемая publisher signature, выбранная схема хранения signing credentials, rollback/downgrade gates, integrity update | Пользователь выбрал текущий unsigned вариант; нового запроса сертификата для него не требуется |

## 1. Сеть: что проверять первым

1. Read-only определить текущие Windows proxy/PAC, DNS и маршруты. Не искать Lagom по фиксированным портам и не импортировать его профиль.
2. На доступном внешнем маршруте проверить Telegram bootstrap/official WSS и длительную receive-сессию; отдельно X public/login/CDN и Instagram login/media. Сохранить codes, длительность и маршрут без секретов.
3. Выключение внешнего маршрута должно давать видимую ошибку сервиса/операции; Relay не запускает собственный engine и не меняет registry/services. Повтор операции получает актуальную Windows policy.
4. При смене внешнего proxy активную загрузку можно завершить ошибкой и повторить. Бесшовную миграцию socket не ставить как необоснованное обещание.
5. Уточнить домены внешней DPI strategy только в отдельной задаче владельца Lagom. Наличие службы/hostlist не доказывает доступность каждого endpoint. DNS не исправляет блокировку IP/соединений.

Текущие незакрытые наблюдения: Instagram `ERR_CONNECTION_RESET`; Telegram `apiw1` `ERR_CONNECTION_TIMED_OUT`. Они не маскируются зелёным локальным статусом.

## 2. Проверка функциональности на аккаунтах

Матрица: Telegram photo/video/round-video/voice/document/sticker; X single/multiple photo/video; Instagram photo/reel/carousel. Для каждого — отображение, повторное открытие, cancel, отсутствие дубля/запоздалого save, clear error при недоступности.

Clipboard: настоящий Windows image/file/text format → вставка в выбранное внешнее приложение, проверка прозрачности/размера/кодировки. Такой тест изменяет глобальный clipboard и проводится отдельно от фонового аудита.

Скачивание: нормальное завершение, cancel до ответа/во время записи, прерывание сети, disk full/access denied, смена аккаунта/закрытие окна, повтор, hash/size. Пересылка/добавление/публикация: сначала read-only preview, затем только отдельно разрешённая операция с server acknowledgement и проверкой отсутствия дублирования. Платные/защищённые материалы и service restrictions остаются действующими.

Точный Shorts другого пользователя необходимо воспроизвести на его версии/сети. Контрольный YouTube sample доказывает работоспособность пути, но не снимает author/bot/geo запреты с любого ролика.

## 3. Стабильность и производительность

Сохранить baseline на idle, большой history, переключении сервисов, медиа и transcription. Записывать RSS/CPU/handles, количество собственных helpers и transient directories, GC/long tasks, cold/warm startup, cancel settlement. Сравнивать одинаковые данные и условия; короткие frame samples не превращать в общий benchmark.

Прогнать минимум 24 h с 10 sleep/resume, 20 сменами доступной/недоступной сети и 100 service switches. Отдельно проверить logout/session end cancellation/complete и обычный exit при работающем worker. Критерии: 0 app crashes в матрице, 0 оставшихся собственных workers после terminal cleanup, отсутствие роста временных файлов при повторе, user-visible failure без бесконечного spinner. WAN error rate приводить с количеством попыток и условиями, без вывода о всех сетях.

Собственный Node CDN direct policy отклоняет fake-IP 198.18.0.0/15. При таком системном DNS требуется поддержанный внешний proxy или обычные публичные ответы; ослаблять SSRF checks автоматически нельзя. Direct yt-dlp не имеет равной proxy gate проверки каждого DNS/redirect; это отдельная задача унификации policy. Для WinHTTP phase timeouts нужен измеренный total PAC/WPAD deadline, а не вывод из значения 2 s.

## 4. Дизайн и доступность

Продолжать [принятую систему дизайна](DESIGN-1.3.0.md). Следующие проверки дают больше пользы, чем очередная смена визуального стиля без данных:

- Реальные native DPI, monitor move, maximized/minimum window и font scale; доступность Close и login/retry без горизонтального overflow.
- Настоящие TGS/WASM/WebM/premium effects; различие standalone sticker и custom emoji; time/reactions/avatars при узких размерах.
- Reader PDF/search/toolbars, recipient picker, account settings и длинные локализованные подписи.
- Screen reader naming, focus restore, Tab order, reduced motion, contrast состояний error/disabled/focus.
- Плановая уборка 509 существующих SCSS warnings по группам с проверкой затронутого поведения, без массового style rewrite ради цифры.

## 5. Поставка и источники

Текущий source ZIP содержит точные project files и vendored Tauri patch; он не является полным комплектом corresponding sources. Для каждого binary/dependency связать SHA-256, upstream version, license, source archive и необходимые build recipes. Для FFmpeg проверить exact configure/build/dependency sources; если их нет, заменить существующий компонент воспроизводимой проверенной сборкой и повторить media/installer gates.

Проверить extraction и clean-room locked build source bundle на независимой машине. Блокировка публичного draft сохраняется до полного source gate. Подпись не добавлять фиктивно, сертификат и канал не объявлять настроенными. Updater остаётся OFF до проверенного канала.

## Критерий завершения публичного выпуска

Все P0/P1 строки имеют датированные результаты с exact artifact hashes и описанными условиями; реальные external failures объяснены, критические сценарии прошли; source/legal delivery gate закрыт. Затем отдельно принимается решение о публикации. Название «production» или проценты готовности не заменяют эти evidence.
