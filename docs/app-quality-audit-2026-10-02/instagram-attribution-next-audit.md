# Instagram attribution — NEXT candidate

Исходники исправлены и локально проверены. Канонический пакет1.4.4 и его release artifacts этой подзадачей не редактировались; установка нового кандидата не выполнялась.

Описание наблюдаемой страницы сохраняется целиком в description и помечается pageMetadata. Оно не становится текстом reel, hasContentText или FTS. Подпись берётся из наблюдаемого h1 либо OG на строгом same-post адресе. SourceContext связывается native с exact pageUrl и выбранным requestedSource. Авторство и коллаборация остаются непроверенными.

Owner aliases согласованы между start, eligibility и caption fallback. Kind p не смешивается с reel; origin, credentials, shortcode и malformed interior slashes проверяются. Fallback на текущую detail page допускается только при отсутствии permalink, а присутствующая отклонённая ссылка не подменяется.

Role-map использует UTF16 диапазоны; single/multi-field, одинаковые ranges и emoji восстанавливаются до принятого JSONL без потери bytes. Payload остаётся bounded4MiBUTF8, части12000codeunits сохраняют surrogate boundaries. Неверные диапазоны, неизвестные ключи и unfinished stream дают явный partial failure; counts/cursors/outcome не расширены. Legacy schema1 остаётся читаемой; существующий JSONL никогда не перезаписывается для derived normalization.

Index normalization text-roles-1 обновляет только явно переданные same-byte shards. Search старой revision возвращает INDEX_NORMALIZATION_CHANGED. Changed raw требует прежнего replaceChanged. UUID, raw SHA и byte locator сохраняются. Metadata-only count1 остаётся записью с explicit missing contentText.

## Проверки

- Actual helper→bridge→FTS:14/14 PASS,10 exact wire cases через actual native validate_data_event; exact4MiB,9000/16000,multifield,alias captions,emoji,adversarial source/ranges/partial и selected/unselected rebuild.
- Native:43/43 PASS final source, offline existing toolchain, own target.
- Existing bridge/export/index:40/40 PASS, включая100000-row known-answer corpus.
- Четыре оригинальных selected public artifacts и pilot SHA проверены без изменений.
- Синтетические HTTPS документы locally fulfilled; остальные requests aborted. Ни app/MCP calls, ни live аккаунты не использовались.

## Точные исходники

| Файл | BeforeSHA256 | FinalSHA256 |
|---|---|---|
| social-read.js | 162335eccc2d6ff1676cd6fc069ce9b62bef077d89a4857ace392ade9450ddd8 | b4f0c13143c7aeffe93508e3166ef78a9757a13a5b369a9a343d51ecd25e368e |
| research_social.rs | c10f737215e3acafaec73d87aa88490dccc4cb45211eb03a58da3a696f7beaa8 | aa29637b67013239bfa735962a1656e55f7ac035f8d61f073607ecd7750028f7 |
| bridge-provider.mjs | 9c2454c190fbcc23704b4cc4621cc542c052853017716c9403e35f445b59a952 | 0adb7ef9b96c561b3ccf296c66bbb6138a21cac59cbc9ac6bdc5f5d5b0f6e64d |
| local-index.mjs | fb68ce70c3eb26720f000d9ee4759d794762ef1d33c0564a353c3c6e503e9598 | 55f500026e03c1b3d1256e80ced799b4e3a91198011c2039c245af75fb4a8add |
| export-format.mjs | 0a9309007f67855653108b43ae5acd2809b2cefe73a031313e9215db53d35a4f | 5941b7af41135153c685cb8890c4215b00325dde76f448f7cbdd89a1c83e1186 |

Patch: [instagram-attribution-next.patch](instagram-attribution-next.patch), SHA256 c2ce719c833dc153bd60c5b2d289ffd9e70486140e9c3e062de03d72832803c4.

[Authoritative JSON report](instagram-attribution-next-audit.json), [final helper receipt](instagram-attribution-next-tests-v9.json), [native43 receipt](instagram-attribution-next-native-v2.json), [regressions](instagram-attribution-next-regression.tap). Before failures и V1 independent review сохранены неизменными.

Следующие gates: root technical acceptance, version/package/source-hash integration, installation и реальная platform/native/session проверка. Этот отчёт не доказывает издателя по URL и не заявляет installed next/live completeness.

## Review objects

- ig-next-provenance: Происхождение страницы и данных публикации. ✓ Да / подтверждаю · ✕ Нет · ? Поясни · Комментарий. Default: unreviewed. Действие: Принять проверенное разделение pageMetadata/sourceContext для следующего кандидата.
- ig-next-post-identity: Строгая идентичность выбранного поста. ✓ Да / подтверждаю · ✕ Нет · ? Поясни · Комментарий. Default: unreviewed. Действие: Принять общий strict comparator и native source guard.
- ig-next-text-roles: Полные поля текста через части. ✓ Да / подтверждаю · ✕ Нет · ? Поясни · Комментарий. Default: unreviewed. Действие: Принять UTF16 role-map восстановление до записи JSONL и производных форматов.
- ig-next-selected-index: Обновление выбранного поискового индекса. ✓ Да / подтверждаю · ✕ Нет · ? Поясни · Комментарий. Default: unreviewed. Действие: Принять revision и перестроение только handed selected same-byte shards.
- ig-next-verification-scope: Проверки и границы следующей сборки. ✓ Да / подтверждаю · ✕ Нет · ? Поясни · Комментарий. Default: unreviewed. Действие: Включить frozen diff в следующий кандидат после технического review родительской задачи.

Общий комментарий и Применить собираются в общем review board родительской задачи; новых пользовательских разрешений этот технический отчёт не запрашивает.
