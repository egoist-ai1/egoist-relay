# Независимый аудит медиа перед 1.3.0

Дата: 29–30 сентября 2026, Europe/Moscow. Исходная версия в начале аудита: 1.2.6. Проверка выполнена по текущим исходникам, а не по заявлениям предыдущего аудита. После независимого анализа выполнены описанные ниже исправления для 1.3.0.

Проверены inline_media.rs, social_share.rs, transcription.rs, worker_job.rs, inline-media-resolver.mjs, social-media-fetch.mjs, media-proxy.mjs, resolveInlineMedia.ts, download.ts, clipboard.ts, documentClipboard.ts и путь подготовки пересылки socialShare.ts. При проверке вызывающих методов дополнительно рассмотрены mediaLoader.ts и DownloadManager.tsx. Интерфейс DocumentReaderModal передан отдельному UI аудитору; ниже его дизайн не оценивается.

## Подтверждённые дефекты

| Приоритет | Место | Условие и результат | Предлагаемое исправление |
| --- | --- | --- | --- |
| P1 | src/util/mediaLoader.ts:34, 147, 179, 184–185, 198, 206–208 | При каждом Blob результате создаётся Object URL. memoryCache не имеет предела, а unload и ветка отмены удаляют только запись Map. Сами URL остаются зарегистрированы, удерживая Blob до завершения страницы. Даже явный unload не освобождает зарегистрированные URL. | Ввести явное владение Blob URL: освобождать только действительно освобождённый ресурс, предусмотреть предел кэша/учёт живых потребителей. Простой LRU с немедленным revoke недопустим для картинки или видео, которые ещё используют URL. |
| P2 | src/components/main/DownloadManager.tsx:73–94 | Отмена download удаляет его из activeDownloads; если Promise завершается позже, обработчик then всё равно вызывает download. Наличие задачи проверяется только в onProgress, а не непосредственно перед сохранением. | Проверить актуальное поколение/наличие download непосредственно после fetch и перед вызовом download/window.open; отменённый или заменённый запрос не должен сохраняться. |
| P2 | src/components/main/DownloadManager.tsx:79–94 | mediaLoader.fetch при сетевом отказе возвращает undefined. then не сохраняет файл, но всё равно вызывает handleMediaDownloaded, удаляя задачу без уведомления об ошибке. В DownloadUrl ветке undefined также может стать URL относительно baseURI. | Явно обработать пустой результат как отказ, показать локализованную ошибку; убрать задачу из прогресса как завершившуюся с ошибкой. Ошибка не должна считаться успешным скачиванием. |
| P2 | src/util/mediaLoader.ts:35, 62–90 | Два одновременных fetch одного URL с разными ApiMediaFormat используют один Promise. Если первым был BlobUrl, Text получает blob URL вместо содержимого текста. | Разделить ключ fetch/cache по представлению или гарантировать общий сырой Blob с отдельной подготовкой каждого формата. Согласовать progress/cancel и cacheApi, чтобы исправление ключа не ломало отмену. |
| P2 | scripts/social-media-fetch.mjs:93–95 | Ответы CDN 403, 429 и 503 сообщаются одним MEDIA_HTTP_FAILED. Классификация bot/geo/rate-limit в yt-dlp ветке не распространяется на прямое чтение CDN. | Разделить как минимум 403, 429, 5xx; сохранить безопасные коды до уведомления в SocialShareModal. Не повторять 429 автоматически в плотном цикле. |

P1 здесь обозначает риск устойчивого роста ресурсов в длительной работе с медиа. Измерение реального RSS пользовательского процесса не проводилось; подтверждены условия удержания зарегистрированных Blob URL и отсутствие ограничителя в этой подсистеме.

## Свежая воспроизводимость

Временные harness исполняют фактические функции из TypeScript/JavaScript исходников; зависимости подменены синтетическими адаптерами. Пользовательский Relay не запускался, Telegram/X/Instagram профили и личные подключения не открывались. Clipboard write и внешние сообщения не выполнялись.

- `media-loader-repro.cjs`: 25 синтетических media fetch, затем 25 unload → 25 URL всё ещё зарегистрированы, 0 revoke. Параллельные BlobUrl и Text запросы одного ресурса → 1 API загрузка, одинаковые результаты `blob:…` у обоих. Проверки harness прошли.
- `download-manager-repro.cjs`: пустой fetch → 0 сохранений, 1 удаление задачи, 0 уведомлений об ошибке. Отмена до завершения Promise → activeDownloads пуст, но 1 последующий вызов сохранения. Проверки harness прошли.
- `cdn-error-repro.mjs`: фактический collectBody с HTTP 403/429/503 → трижды MEDIA_HTTP_FAILED. Проверки harness прошли.

Harness и полные логи находятся в собственном временном task work:
`C:\Users\Egoist\Projects\.agent-brain\chat-runtime\tasks\01a0eede-3592-7700-a72e-913885f761d9\work`.

## Результаты существующих тестов

| Проверка | Результат | Что подтверждает |
| --- | --- | --- |
| Node `scripts/media-proxy.test.mjs scripts/social-media-fetch.test.mjs` с task EGOIST_RELAY_AUDIT_WORK | 27/27 passed, 0 skipped | Обработка SOCKS/HTTP CONNECT, CDN allowlist/redirect, размер, yt-dlp error classification, среда engine, synthetic cookies, очистка временных файлов, размерный guard, duration limit |
| Vitest download/clipboard/documentClipboard/resolveInlineMedia/socialShare/InlineSocialMedia | 50/50 passed, 6 файлов | Очередь сохранения, mocked clipboard failures/deadline, преобразование DOCX текста, IPC cancellation queue, packet bounds, social-share randomId/retry/cleanup, YouTube recovery/visibility |

Логи: node-media-tests-all.log и frontend-media-tests.log в указанном work. Успешные unit тесты не покрывали обнаруженные DownloadManager и mediaLoader дефекты. Нативные Rust тесты выполняет root отдельно; их результат в этот отчёт не присваивается.

## Проверенные границы и ограничения

В native inline resolver есть один ACTIVE job, ограниченный журнал cancel, проверка UUID и канонического provider URL, 64 MiB для файла, ограниченные метаданные/длительность, проверка локального результата ffprobe, собственный Windows WorkerJob и cleanup owned directory. IPC разрешён только main локальному WebView. Worker использует proxy и provider allowlist gate; cookie retry берёт только соответствующий X/Instagram WebView, с пределами числа/размера и очисткой временного cookie файла. Признаков записи cookie в argv или повторного использования стороннего профиля в этом пути не найдено.

Native transcription проверяет PCM WAV, до 30 минут и 64 MiB входа, один ACTIVE job, cancel/timeout и ограниченный JSON результата. Утверждать качество распознавания реальной речи или частоту отказов без разрешённой выборки аудио нельзя. Восстановление после аварийного завершения и WebView2 shutdown не испытывались в этой подпроверке.

Social share ограничивает количество вложений, общий объём и время; frontend удерживает randomId/localMessage при повторной отправке, освобождает подготовленные URL при отказе/закрытии, проверяет ограничения получателя. Это подтверждено кодом и mocked тестами; реальная пересылка не выполнялась.

Без URL и логов проблемного Shorts на другом устройстве не доказана причина его отказа. Действующие bot/geo/авторские ограничения сервисов не превращаются в гарантию доступности после клиентских исправлений.

## План проверки исправлений

1. Regression tests DownloadManager: пустой результат, отмена до resolve, замена задачи тем же hash, нормальный успешный save.
2. Media lifetime: synthetic create/release accounting; повторные view/download потребители; release не ломает активное изображение/видео; bounded retention в длительной сессии.
3. Formats: одновременно BlobUrl/Text и повторное получение после cache; независимые callbacks и отмена.
4. CDN: 403/429/5xx сохраняют различимый безопасный код; таймаут, redirect и size tests продолжают проходить.
5. Финальная проверка собранного приложения в отдельном профиле — воспроизведение/остановка и чистый shutdown. Реальная чужая сеть остаётся отдельной неподтверждённой областью.

## Реализация и повторная проверка

- DownloadManager хранит отдельное поколение задачи с её исходным metadata. Поздний результат не сохраняет отменённую или заменённую задачу. Перед фактическим click очередь download проверяет отмену ещё раз. Пустой/rejected результат сообщает RelayDownloadFailed; пустой DownloadUrl не открывает адрес приложения. Удаление завершённой задачи также проверяет metadata, чтобы не удалить новую задачу с тем же hash.
- download возвращает Promise с результатом запуска сохранения, который завершается после click или пропуска отменённого задания. Это подтверждает запуск сохранения, а не успешную запись файла операционной системой.
- mediaLoader разделяет запросы и память по URL, ApiMediaFormat и разрешению HTML. Progressive/DownloadUrl fallback нормализуется к BlobUrl только когда progressive путь недоступен. Кэшированное представление повторно используется; Text не получает Blob URL другого consumer.
- Отмена одного progress consumer отсоединяет его, сохраняя общую загрузку другого progress consumer или viewer без callback. Если единственный consumer отменил запрос, новая загрузка ждёт завершения отменённого IPC и начинает новый запрос. unload не позволяет позднему результату вновь заполнить удалённый ресурс.
- Blob URL имеет явного владельца в записи кэша. retainMedia возвращает идемпотентный release; два media hook, DownloadManager и DocumentReader держат lease во время использования. unload удаляет запись из кэша, но сохраняет leased URL до последнего release. URL, которым никто не владеет, освобождается при unload сразу.
- Для idle памяти используются пределы 512 записей и 256 MiB. Один cleanup timer удаляет самые старые неприкреплённые записи после периода в 5 минут. Leased ресурс сохраняется независимо от лимита. Ни активная картинка/видео, ни ожидающее очереди скачивание не отзываются простым LRU.
- CDN чтение сохраняет безопасные коды 401/auth, 403/forbidden, 404/410/unavailable, 429/rate limit, 5xx/connection. Неожиданное Content-Encoding классифицируется как unsupported format. Отображение этих кодов в SocialShareModal относится к общей интеграции root.

Период в 5 минут защищает кратковременных прямых consumers: image clipboard имеет deadline 15 секунд, локальная расшифровка — 120 секунд загрузки, composer/preload/notification начинают чтение непосредственно после получения URL. Длительные viewer и PDF используют lease. Лимит является мягким на протяжении этого периода и при наличии active leases; это не верхний предел памяти всего приложения. Новый consumer, который хранит URL длительное время, обязан вызвать retainMedia до получения ресурса и release после завершения.

Добавлены непосредственные regression tests функций mediaLoader, очереди download и настоящего Teact DownloadManager: формат/HTML изоляция, два lease/unload/idempotent release, 25 load/unload циклов, ограничение idle count/bytes, отсутствие per-entry timer, cancel/shared consumers, retry после cancel, stale result/metadata, empty/rejected result, queued click cancellation и lease до сохранения. Тест byte budget использует синтетический declared Blob size, не выделяет сотни MiB реальной памяти. Измерение RSS и стресс длительной реальной сессии остаются нативным интеграционным этапом root.

Свежие результаты после изменений:

- Node media/proxy: 36/36 passed, 0 skipped (`node-media-tests-after.log`).
- Затронутые frontend suites: 69/69 passed, 8 файлов (`media-fix-affected-tests-after.log`).
- TypeScript `tsc --noEmit`: exit 0 (`media-fix-types.log`). Scoped ESLint затронутых TS/JS: exit 0 (`media-fix-eslint-final.log`).
- Общий `npm run check:ts` запускался; на момент запуска соседние release/documentPreview файлы ещё менялись и дали 12 ошибок плюс одно предупреждение (`media-fix-check-ts.log`). Эти файлы принадлежат другим аудиторам; результат финального общего gate публикует root после их завершения.

Пользовательские аккаунты, установленный Relay, настройки сети, Clipboard и внешние сообщения в реализации не использовались. Нормальная запись файла на диск и provider доступность подтверждаются отдельными нативными проверками, а не mocked unit tests.
