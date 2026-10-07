# Relay planned1.4.4 — итоговая проверка исходников, версия 5

Текущий пакет 1.4.3; планируемая версия1.4.4. Проверка исходников, не сборки/установки/аккаунтов. Платёжные draftправки не применены.

| Авторитетный текущий контекст | Exit | Диагностики |
|---|---:|---:|
| canonical src | 0 | 0 |
| canonical test — все26файлов | 0 | 0 |
| canonical script —47roots | 0 | 0 |
| actual browser fixtures —4TSX | 0 | 0 |
| whole maintained-source ESLint —1866files | 0 | 0errors; 1warning |

Финальные исходникиUI4/configs/fixtures: SHA в JSON; watchedinputs изменились=0. Команды, полный список26testфайлов,47scriptroots, конфигурации, все исходные ошибки и exactlog SHA сохранены. Временные полные логи — только ownruntime.

## История исправления checkercontext

Первый дополнительный canonical scriptcontext44roots дал2393диагностики, потому не включал существующие global/browserambient declarations. QA-only добавление3существующих деклараций иbrowserlibraries сохранило44roots иоставило2ошибкиQR. Существующий canonical main alias qr-code-styling→src/@types/qr-code-styling устранил2ошибки в ownконтексте. После source-backed review root внёс ровно эти type-only настройки в canonical scriptconfig; actual47root canonical запуск 0. Runtime source не менялся этой работой. До/после записи сохранены;2393ошибки не названы2393регрессиями продукта.

Первый внешний browsercheckercontext дал3TS2688из-за ownruntimeancestor resolution. Исправлен исключительно путь к существующимprojecttypes, после чего все4fixtures TSC0. Их runtime bodies не менялись.

ESLint сначала нашёл typedparser mismatch у immutable historical beforeaudit в docs. Правильный Nodecontext выявил3архивных JSдиагностики. Обе попытки сохранены. Root зафиксировал архивную policy: docs/**/*.test.mjs исключены как неизменяемые snapshots, аналогичноVitest; поддерживаемые src/scripts продолжают проверяться теми же правилами. Archivebytes не редактировались, Nodeglobals/rules не ослаблялись. Финальный wholelint0errors.

Оставлена исходная unsuppressed DocumentReaderModal307 warning dangerouslySetInnerHTML. Отдельный source review проверял escaping/протоколы/textnodehighlighting; warningсама по себе не доказывает injection.

## Границы

ESLint действующим config не включает scripts TSXfixtures; им дан explicit typecheck, отдельный TSXlintPASS не заявляется. Проверка types не является runtime26suitePASS: для исполнения используйте отдельный rootVitest receipt. Paymentcallback failuresbefore сохраняются отдельно и не закрыты этим sourceQA. Никаких реальных платежей/API/account/system mutations.

Neutral reviewobject версии5: Да/Нет/Поясни+комментарий, unreviewed. Подтверждение принимает наблюдаемую sourceQA, не разрешает установку или платежи.
