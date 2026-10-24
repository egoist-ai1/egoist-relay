# Аудит Egoist Relay 1.2.1

Продолжение [аудита 1.2.0](AUDIT-1.2.0.md): компактные медиа в Telegram, подтверждённое закрытие share-окна, обработка видео и восстановление встроенной офлайн-расшифровки. Предыдущие принятые EXE, NSIS и manifest 1.2.0 проверены по исходным SHA-256 и сохранены. Новые библиотеки JavaScript/Rust не добавлялись; внешние движки, модель и их лицензии входят в runtime.

## Интерфейс и отправка

Весь контейнер вертикального сообщения ограничен шириной 21rem; перенос длинной ссылки применяется к внешнему message layout. Корректная геометрия проверена на широком и узком viewport. Один активный плеер останавливается при уходе за viewport, скрытии документа или переключении сервиса. YouTube origin и contentWindow проверяются перед обработкой событий; состояние «playing» требует реального подтверждения, а загрузка iframe не выдаётся за начало видео. Автозапуск отправляет mute и playVideo после готовности; явный play доступен при блокировке.

Быстрое переключение между видео ждёт фактического завершения отменённого IPC; отменённый запрос в очереди не запускает новую загрузку и сразу завершает ожидание пользователя.

Instagram/X-видео обрабатывается локальным HTML5-плеером из ограниченного бинарного ERMS-пакета. Проверяются magic, размер, MIME и индекс. Явные photo-only предпросмотры и текстовые X-status сохраняются нативными. Извлечение зависит от фактической доступности публикации.

Share использует выделенную очередь с фиксированным получателем и стабильными randomId. Каждая часть требует подтверждения Telegram; подтверждённые части не отправляются повторно. Специальный shouldSkipFocus применяется только к этой операции. Обычная отправка сохраняет свой контракт. Ошибки загрузки изображения освобождают даже Blob URL, созданные до возврата attachment builder. После успеха показывается получатель и закрывается overlay; ошибка восстановления overlay сохраняет кнопку повтора без новой отправки.

## Основное окно

Начальный запуск и восстановление используют один builder с одинаковым профилем и прокси. Внутренние ссылки проверяются по фактическому локальному origin основного WebView, затем используют его без создания дополнительных UUID-окон. Закрытие основного окна сохраняет его в трее независимо от окон авторизации. Скрытые X/Instagram WebView не запрашивают начальный фокус. Команды заголовка, счётчика уведомлений и сохранения адреса обращаются к Window или WebView отдельно, поэтому наличие дочерних сервисов не блокирует их. Реальные проверки reuse, external rejection, close/restore и наблюдение с момента холодного запуска записаны в native-verification.json и primary-window-verification.json; окна авторизации проверены по исходникам, отдельный вход не выполнялся.

## Локальные движки и соединение

Whisper.cpp 1.9.4 CPU с multilingual small-q5_1 и Silero VAD находится в runtime/transcription. На ясном русском Ogg/Opus 17,7 с распознавание ядром заняло 3,77 с. Эта одна запись не доказывает качество всех голосов или языков. Аудио декодируется в памяти до PCM 16 кГц/mono/16bit через существующий WebAudio и worker; Tauri получает ограниченный raw binary body с UUID. Desktop не вызывает Telegram cloud transcription. Результат привязан к исходному аккаунту/сообщению. Браузерная ветка сохраняет свой Telegram-контракт и не обещает локальное распознавание.

Движок обрабатывает одну задачу до 30 минут/64МиБ, использует до 6 CPU-потоков с пониженным приоритетом и имеет 900 с runtime timeout. Отмена, ошибки, exit и startup cleanup касаются только принадлежащих приложению каталогов/процессов. Windows Job Object удерживает дерево своих workers. App-local CRT и все CPU backends поставляются вместе. UTF-8 manifest CLI изменяет только resource section; исходный и производный SHA, лицензии и проверка кириллических путей записаны в provenance. Для Unicode manifest требуется Windows 10 version 1903 или новее.

yt-dlp 2026.08.19, существующий Node 24 и FFmpeg/ffprobe 9.0.2 поставляются в runtime. Separate A/V streams объединяются локально; ffprobe проверяет локальные streams, duration и контейнер с ограниченными протоколами. Экстрактор разрешает канонические provider URL, фиксированные provider/CDN names и port 443 через собственный loopback SOCKS gate. Gate сохраняет upstream domain resolution; ему не приписывается независимая фиксация DNS IP. TLS-проверка не отключается.

Только после ошибки авторизации Instagram/X может использовать ограниченный набор cookie из своего точного child WebView. Cookie передаются в stdin и временный принадлежащий job файл; внешние профили браузеров, Telegram storage и YouTube credentials не читаются. Временный cookie/media файл очищается до успешного IPC-ответа и при сбоях/отмене. Входящая ссылка не создаёт автоматическую отправку сообщения. Удаление этих временных данных не означает удаление обычного Telegram/browser media cache.

Системные VPN, DNS, proxy и firewall не изменялись. Готовность локальных служб не означает доступность каждого CDN; совместимость с любой сетевой конфигурацией не заявляется.

## Проверки и происхождение

| Проверенный слой | Результат | Evidence |
|---|---|---|
| Реальные Teact/layout/HTML5 lifecycle, mocked provider/native IPC |56 assertions passed|inline-media-verification.json|
| Реальные share-компоненты и GramJS method на MockClient |30 scenarios passed|social-share-verification.json|
| AudioContext/Ogg/worker, native core, actions/privacy |35 cases passed|transcription-verification.json|
| Rust URL/cleanup/cancel/cookies и реальные Windows Jobs |39 cases passed|inline-media-native-verification.json|
| Media worker/SOCKS, настоящий FFmpeg-generated A/V и ffprobe |51 cases passed|inline-media-native-verification.json|
| Компактная injected share-кнопка в реальном isolated DOM |12 cases passed|inline-media-native-verification.json|
| MCP 1.0.5 typed contract/gate/stdio discovery |74 window + 50 speech + 38 policy cases passed, 20 tools|mcp-source-verification.json|
| Full TypeScript/ESLint, stylelint, frontend, Rust/NSIS |exit 0; 3120 входов до/после без изменений; maps 0|build-verification.json, build-gates.json|
| Окончательный native EXE и окно через отдельный MCP |Точный охват в отчёте|native-verification.json|
| Изолированный NSIS, полный runtime, установленный движок, exit/uninstall |Точный охват в отчёте|installer-verification.json|

После последней нативной правки проверки TypeScript/ESLint, стилей и frontend-сборка перенесены с прошедшего кандидата: сравнение всех входов подтвердило изменение только tauri/src/lib.rs. Нативный код и NSIS собраны заново. Остались 2 существующих ESLint warnings, 510 stylelint warnings и 1 сообщение линковщика. Первая попытка упаковки столкнулась с Windows file lock после запуска собственной тестовой копии; её штатно закрыли и пакет пересобрали с exit0. Промежуточный EXE и его 4 успешные Tauri speech probes отделены в native-transcription-prebundle-verification.json от окончательного SHA. Промежуточные installer-pre-window-fix-verification и installer-primary-reuse-failed-verification сохраняют собственные SHA и результаты; они не подтверждают окончательную сборку. Feature-source comparisons 45 совпали с текущими файлами. Синтетический Telegram RPC не выдаётся за отправку в реальный аккаунт; в аудите реальные сообщения, публикации и платежи не выполнялись.

Существующие аккаунты в окончательной 1.2.1 не перепроверены: открытая пользовательская копия требует штатного выхода перед запуском с привязкой MCP. В 1.2.0 их проверка сохранена отдельно; она не выдаётся за проверку 1.2.1.

Изолированная установка проверяет отдельную test registration и полный набор поставки, сохраняя пользовательскую установку. Точные clone-отличия и fingerprints отражены в installer-verification.json. WebView2 на машине уже установлен; первая установка на чистой Windows отдельно не проверена. Установщик содержит офлайн-пакет WebView2.

Короткие performance samples приводятся со своим visibility/context и не доказывают плавность всех функций. Удалённые ограничения, недоступные/private публикации, DRM, multi-item video galleries и реальные загрузки/доставка не считаются автоматически пройденными. В публичном full-download smoke YouTube вернул MEDIA_AUTH_REQUIRED; metadata success не объявляется реальным воспроизведением. Хэши документов, отчётов и артефактов доступны в release-manifest.json и SHA256SUMS.txt.
