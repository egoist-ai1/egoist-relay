# Область проверки 1.4.6

| Проверка | Результат |
| --- | --- |
| Vitest | 26 suites, 322 passed, 0 failed |
| Share helper | 30 passed |
| Reels alignment | 4 passed |
| Actual App recipient picker, synthetic session | 20 passed |
| Native Rust | 11 passed |
| TypeScript | 3 configurations passed |
| Isolated installer | Install, launch and uninstall passed |
| Installed identity | EXE/version and 40 runtime files verified |
| Three-provider proof | Telegram, X, Instagram confirmed inside bounded warmup |

Software checks total: 387. TypeScript configurations и installer smoke являются отдельными gates и не увеличивают этот test count. У helper/recipient проверялись feed/DM, narrow/RTL, light/dark, reduced motion, keyboard/cancel/copy failure и duplicate action guards. Реальных отправок или clipboard writes в synthetic UI тестах не было.

Данные проверки опубликованы в [verification-1.4.6.json](verification-1.4.6.json), без личных runtime путей, account refs, nonce, PID или private configuration hashes.

## Границы

- Проверки конечны: они не сертифицируют каждый аккаунт, каждый источник, все серверные ветви или максимальную скорость интернет-канала.
- DOM collection может быть частичным; отсутствие поля сохраняется как неизвестное значение.
- Instagram не предоставляет универсальный keyword search через этот DOM интерфейс.
- Платформенные challenge/rate/access restrictions не обходятся произвольными account calls.
- Отправки, платежи, joins и чтение личных диалогов не включены в опубликованное live proof.
- Тесты пакета относятся к локальной reviewed сборке, а не к ещё не выполнявшемуся GitHub Actions run.

## Проверка публичной копии

После подготовки публикации выполнены 25 synthetic MCP broker tests и 12 media proxy tests: все passed. Ещё 7 media scenarios skipped, в том числе 6 требуют локальную TLS fixture, 1 — task work input. Это отдельная проверка публикации; исторический release count остаётся 387.

## Тестовые TLS fixtures публичной копии

В двух дополнительных тестовых файлах удалены встроенные TLS key/cert. Для этих TLS сценариев задаются локальные синтетические EGOIST_RELAY_TEST_TLS_KEY и EGOIST_RELAY_TEST_TLS_CERT; без них сценарии помечены skipped. Сертификат должен включать тестовые SAN pbs.twimg.com, video.twimg.com и scontent.cdninstagram.com. Проверенные production inputs остаются неизменными. Исходные и опубликованные SHA256 всех адаптированных supplemental tests указаны в source-manifest-1.4.6.json. Это адаптация публикации и не новый прогон исторических 387 checks.

## Контрольные суммы локальной проверенной сборки

Installer SHA256: 3f723548168e83278e80300a9e3876ef738590ef8c90f1a7d00dc78b099fcfdd

Executable SHA256: c7489e92a84eb8c691e90f39d6b88b7fed0d5dec412c1f0f0a79d7d340cfe4ab

Эти суммы идентифицируют проверенные локальные артефакты; бинарный upload в этой source publication не выполняется.

## Уточнение публичного тестового harness

В ветке codex/release-1.4.6 после первичной source публикации добавлены пропущенные skip markers для двух TLS disk-budget scenarios без локальной key/cert fixture. Runtime исходники версии1.4.6 не изменены. Полный stress harness требует локальные тестовые key/cert и точный media runtime; этот отдельный прогон не заявляется. Tag relay-v1.4.6 сохраняет первоначальный публичный snapshot; актуальная ветка содержит этот test-only correction.
