# Публичные операции Egoist Relay / SocialMCP

Окно: 2026-10-02T04:16:39.535Z — 2026-10-02T04:17:06.860Z. Daemon **9116**, source SHA256 **8bbbb58e8063d507d121c96db644973b751a59cf3a593a8bde98b5b5615769c3**, **193975 байт** в 13 файлах. Установленная версия **1.4.2** подтверждена родительским runtime receipt; этот пилот отдельно EXE не аттестует.

**Пять уникальных заданий завершены: 9 принятых записей, 0 ошибок, 0 повторов. Все результаты частичные.** Идентичность каждого ID и SHA256 каждого возвращённого JSONL/manifest перечитаны после завершения.

| Операция / выбранный источник | ID | Состояние / количество | Курсор | Время source run |
| --- | --- | --- | --- | --- |
| telegram-history-durov | a714a123-1530-494c-b972-5b3fcd81c498 | partial / 2 | есть | 697 ms |
| telegram-discover-durov | d0f765b2-ec5e-4965-ae6f-cb523ba4fb26 | partial / 2 | нет | 699 ms |
| x-discover-openai | 51ec3a51-3c3d-4697-9f71-eedade0830b1 | partial / 2 | есть | 4083 ms |
| instagram-discover-openai | bc489fef-e833-403f-ac44-4d31769519d3 | partial / 1 | нет | 12577 ms |
| instagram-history-openai | aa16e903-4198-4d59-bfe9-15ef4b78d358 | partial / 2 | есть | 5474 ms |

Каждое задание: limit 2, pageSize 2, deadline 45000 ms. Операции одного сервиса выполнены последовательно; независимые сервисы параллельно. Readiness проверена через status.broker.providers.find: после трёх проверок все сервисы ready. Финальный status показывает свободные очереди, Telegram/Instagram ready, X dom_account_proof_pending. Новых действий после этого состояния нет.

Telegram after/before не заданы: до выбора задания не передан наблюдённый timestamp выбранной записи. Полученные даты находятся в JSON; дополнительное задание с фильтрами не выполнялось.

## Источники и ограничения

- All five results are partial. Returned records prove these selected bounded operations only, not platform-wide access, completeness or unlimited throughput.
- No cursor continuation, timestamp-filtered Telegram history, joins, private dialogs, DM reading, sends, uploads, account settings or media downloads are attempted in these five jobs.
- Telegram history exposes observed peer/message locators and dates but sourceUrl is absent. Telegram discovery scope public_groups is implemented as account_server_search/public_channels and returns two public chat records; public handle evidence is absent on one returned record.
- X profile discovery yields profile previews for OpenAI and OpenAIDevs; API-only profile fields are not verified. Final X readiness returns dom_account_proof_pending even though the exact discovery job settled with records.
- Instagram discover selected handle openai yields one observed profile. It does not prove exhaustive Instagram profile search.
- Instagram channel openai history yields two reel links under chatgpt. The source account association/collaboration is unverified; author objects are empty and captions/timestamps are unobserved. Do not attribute those reels to openai based only on this receipt.
- X and Instagram manifests preserve visible_dom and virtualized_dom_history_incomplete. Source DOM extraction does not establish source completeness.
- Elapsed durations measure these small live operations including provider execution. They are not media transfer throughput or ISP speed benchmarks.

## Проверенные файлы

### telegram-history-durov

Coverage: channel; [каталог задания](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\a714a123-1530-494c-b972-5b3fcd81c498>).

- [records.jsonl](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\a714a123-1530-494c-b972-5b3fcd81c498\records.jsonl>) — 13117 байт; SHA256 7202cc8f394a23e6bee5bb4a00e436ae7284dc264f64a4f9e72ceb9bbe3f0dbb.
- [export-manifest.json](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\a714a123-1530-494c-b972-5b3fcd81c498\export-manifest.json>) — 1200 байт; SHA256 6df27e96d15ad573a1e7c4dd124401498734940fbc473e81bc5abdc06996d1f7.
### telegram-discover-durov

Coverage: public_channels; [каталог задания](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\d0f765b2-ec5e-4965-ae6f-cb523ba4fb26>).

- [records.jsonl](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\d0f765b2-ec5e-4965-ae6f-cb523ba4fb26\records.jsonl>) — 4041 байт; SHA256 bda410f405cc9095b3489f4017b488c680a8aa8bf6f1a8bc96e78f3f9777bc2b.
- [export-manifest.json](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\d0f765b2-ec5e-4965-ae6f-cb523ba4fb26\export-manifest.json>) — 985 байт; SHA256 390e4ab3bccba86a435f00b4ee319f6054b48d905f43cc1d2c7bf16709151cc3.
### x-discover-openai

Coverage: platform_search; [каталог задания](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\51ec3a51-3c3d-4697-9f71-eedade0830b1>).

- [records.jsonl](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\51ec3a51-3c3d-4697-9f71-eedade0830b1\records.jsonl>) — 1780 байт; SHA256 7a11fae710536b12c354c2fd213a29e2f4f8e0ef0a858993c9cf61cc809e0a33.
- [export-manifest.json](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\51ec3a51-3c3d-4697-9f71-eedade0830b1\export-manifest.json>) — 1383 байт; SHA256 13593adf748250950edfab8e9b2539302646c18e63f17ad8635cdec1eba13aca.
### instagram-discover-openai

Coverage: platform_search; [каталог задания](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\bc489fef-e833-403f-ac44-4d31769519d3>).

- [records.jsonl](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\bc489fef-e833-403f-ac44-4d31769519d3\records.jsonl>) — 5315 байт; SHA256 b3b9f35043412f5586781a8195329f4a59a68c379ce01a9be787cf7d8d0a7461.
- [export-manifest.json](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\bc489fef-e833-403f-ac44-4d31769519d3\export-manifest.json>) — 1146 байт; SHA256 431fc83e9075ae811d211bf406443aed1a4ed40841285b7fe42475eef387d4b7.
### instagram-history-openai

Coverage: channel; [каталог задания](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\aa16e903-4198-4d59-bfe9-15ef4b78d358>).

- [records.jsonl](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\aa16e903-4198-4d59-bfe9-15ef4b78d358\records.jsonl>) — 5581 байт; SHA256 591bb7a532b01f5feb7d33d2b9d3adafa78dbce60d1f4aeaa27fe921bbf0ade7.
- [export-manifest.json](<C:\Users\Egoist\Desktop\Проекты\Материалы\Социальные исследования\aa16e903-4198-4d59-bfe9-15ef4b78d358\export-manifest.json>) — 1350 байт; SHA256 757c7e6ce135de481a5f8b4402fb180243adecc29191b9aa5f7725e88da50c0c.

## Обратная связь

Авторитетный снимок: [public-operation-pilots.json](public-operation-pilots.json). Два точных reviewObjects включены для общего companion review board родительской задачи: public-operation-selected-live-evidence и public-operation-instagram-source-association. Для каждого предусмотрен нейтральный выбор ✓ Да / подтверждаю, ✕ Нет, ? Поясни и комментарий; подтверждение принимает указанный вывод, не запускает аккаунтные изменения.

Production, сетевые настройки, системный DNS/DoH, Lagom, приоритеты и пользовательские процессы этим пилотом не изменяются. Личные диалоги, сообщения, вступления и другие аккаунтные мутации не используются.
