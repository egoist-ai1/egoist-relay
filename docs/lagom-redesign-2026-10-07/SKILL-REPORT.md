# Отчёт: skill `egoist-social-research`

Дата: 2026-10-08. Репозиторий правил: `C:\Users\Egoist\Desktop\EgoistCODEX AI`, коммит `5e134a7` (ветка `main`, без push). Проект Social MCP (`Инфраструктура\Egoist Social MCP`) не менялся и не коммитился.

## 1. Что создано

Skill `skills/egoist-social-research/` — единственный источник, глобальный (раскладывается `install.py`).

| Файл | Строк | Байт | Назначение |
|---|---|---|---|
| `SKILL.md` | 61 | 10 162 | frontmatter, порядок работы (status, plan, run, job(wait), records/stats/export, итог), выбор ветки, прежние инструменты, границы, проверка результата |
| `references/telegram.md` | 46 | 5 769 | форматы источников, стадии, темп и `resolve`-бюджет, типичные отказы, вступление |
| `references/x.md` | 43 | 5 243 | то же для X (чтение DOM, виртуализация, риск) |
| `references/instagram.md` | 43 | 5 177 | то же для Instagram (профили и хэштеги, чего нет) |
| `references/limits-and-risk.md` | 84 | 11 172 | темп (AIMD), бюджеты, причины `waiting`, риск и подтверждение, когда спросить владельца, известные дефекты сборки |
| `references/records.md` | 84 | 10 271 | запись item v2, фильтры, поиск, страницы, статистика, выгрузка |
| `references/troubleshooting.md` | 74 | 9 204 | 19 кодов ошибок, диагностика моста и демона, команды `research-service.mjs` |
| `scripts/export_summary.py` | 119 | 5 239 | сводка JSONL/CSV выгрузки без внешних пакетов; тексты не печатает |
| `scripts/tests/test_export_summary.py` | 101 | 4 482 | 7 офлайн-тестов (по образцу `video-research/scripts/tests`) |

Описание (233 символа из 240): `Bulk read-only Telegram, X, Instagram research via Egoist Social MCP and Relay accounts. Use to parse/export sources; когда просят спарсить канал, выгрузить посты, массовый парсинг, исследовать Telegram, X, Instagram, аккаунты Relay.`

Также добавлена строка в `docs/skill-routing.md`: «Соцсети через аккаунты Relay: выгрузка, парсинг, поиск по накопленному» ведёт на `egoist-social-research`; прежняя строка osint-research переформулирована («Публичные источники, проверка сущностей») и ссылается на новый skill как на соседа.

## 2. Проверки

| Проверка | Результат |
|---|---|
| `skill_check.py skills/egoist-social-research` (семь правил) | нарушений 0; SKILL.md 61 строка, описание 233 |
| `skill_check.py skills` (все) | 34 skills, 2 нарушения — прежние, в `hyperframes-animation` (оглавление в двух blueprints); новый skill их не добавил |
| `python -m unittest discover -s tests -q` | 28 тестов, OK (1 пропущен, прежний, не связан с новым skill) |
| `python -m unittest discover -s skills/egoist-social-research/scripts/tests` | 7 тестов, OK |
| `python install.py` (без `--apply`) | показывает `create` для claude и `conflict` для codex, см. раздел 5 |
| Содержание сверено с кодом | инструменты и схемы (`tools.mjs`), политика (`policy.mjs`), план/риск/подтверждение/статус/задание (`orchestrator.mjs`), планировщик и коды (`scheduler.mjs`), регулятор, записи/поиск/выгрузка (`records-query.mjs`), нормализация (`normalize-item.mjs`), источники (`source-input.mjs`), шаг моста (`step-provider.mjs`), `mcp.mjs`, README, ORCHESTRATION, BRIDGE-CONTRACT |

Не запускалось: `install.py --apply` (по заданию); живой Social MCP и аккаунты Relay (сервер не вызывался, выгрузки и секреты не читались); тесты проекта Social MCP. Один раз вызван чистый импорт `normalizeRequest` из `broker.mjs` для проверки дефекта из раздела 4.

## 3. Расхождения план и код (решены в пользу кода)

| План (`MCP-SKILL-PLAN.md`) | Код | Что записано в skill |
|---|---|---|
| Стадии `posts, comments, reactions, media_meta, media_files, members` | рабочие только `source_info` и `posts` (`media_meta` складывается в `posts`); `comments`, `reactions`, `media_files`, `transcripts` — `stage_not_implemented`; `members` — `disabled_by_policy` | так и написано в ветках |
| `probe=true` считает размеры через аккаунт | мост не умеет (`supportsProbe: false`); оценка — верхняя граница `perSourceLimit × источников`, `basis: unknown` | написано в SKILL.md и limits |
| `goal.query` — поиск внутри источников | `UNSUPPORTED` | поиск делается по накопленному через `social_records` |
| `mode: refresh` — только новое (`min_id`) | полный проход, дубликаты отсекает хранилище | отмечено |
| Состояния ожидания: 6 причин | в коде ещё `retry_backoff` и `provider_busy` | добавлены в таблицу |
| Хранилище: по SQLite на платформу, Parquet позже | одна БД `store\research.db` + сырые JSONL-сегменты | про файлы хранилища в skill только локатор записи |
| Дедуп по тройке, близкие тексты | дедуп по (платформа, источник, ID); одна запись под двумя источниками хранится дважды | отмечено в records |
| Ошибки: 15 кодов | 19 (плюс `PLAN_EXPIRED`, `CONFIRMATION_REQUIRED`, `BUSY`, `STATE_LIMIT`) | таблица из 19 |
| Каркас SKILL.md ≈ 70 строк | 61 строка | уложено |
| Хэштеги — Instagram; для X окна дат через поисковый оператор | оператор не реализован; в `.txt` строка с `#` в начале — комментарий, хэштег пишется `ig:#тег` | отмечено |
| Поиск X по `q/f`, ответы, статьи, скачивание | только прежний `social_submit` | вынесено в раздел «Прежние инструменты» |
| Риск X/Instagram «по условиям платформ» | в коде: X `medium` (больше 200 — `high`), Instagram `medium` (больше 50 — `high`), Telegram больше 1000 — `medium`, больше 3000 — `high`; подтверждение при источников больше 300, записей больше 1 млн, риске `high` | пороги записаны как в коде |
| `social_job.progress` содержит `waiting` по причинам | `waiting[]` на уровне `data`, а в `progress.sources` есть `queued`, `unavailable`, `skipped` | по коду |

## 4. Найденный дефект проекта Social MCP (код не менялся)

`goal.after` и `goal.before` в `social_plan` — ISO-даты, а `step-provider.mjs` передаёт их мосту как есть; `normalizeRequest` (`broker.mjs`) требует целые Unix-секунды. Проверено вызовом: `after: '2026-01-01T00:00:00Z'` даёт `INVALID_REQUEST`, `after: 1767225600` проходит. Следствие с живым мостом: каждый шаг источника отклоняется, после 6 попыток источник `failed`. Синтетический провайдер даты игнорирует, поэтому тесты этого не ловят. Предложенная правка: в `step-provider.mjs` перед `request.input.after/before` переводить ISO в секунды (`Math.floor(Date.parse(x)/1000)`) и добавить тест на мост-заглушку. Пока не исправлено, skill (limits-and-risk.md) запрещает использовать `goal.after/before` с живым мостом и советует отбирать по времени через `filter.after/before` при чтении.

Второе замечание по коду: источник, остановленный по `perSourceLimit`, получает состояние `done`, и `corpus.incomplete` его не помечает; в skill добавлена явная проверка (items равно `perSourceLimit` значит «остановка по лимиту, не конец истории»).

## 5. Что нужно решить координатору

1. **`install.py` показывает `conflict` для codex.** `~\.codex\skills\egoist-social-research` — символическая ссылка на старый skill внутри проекта Social MCP, `install.py` считает её чужой. Перед `--apply` ссылку нужно убрать (удаление ссылки вне временных папок — по явному «да» владельца), после чего `install.py --apply` создаст junction на новый skill. Для claude план — `create`.
2. **Старый `Egoist Social MCP\skills\egoist-social-research\SKILL.md` не удалён.** Предложение замены: заменить его файл короткой ссылкой «Единственный источник — `C:\Users\Egoist\Desktop\EgoistCODEX AI\skills\egoist-social-research\SKILL.md`; здесь не дублируется» и поправить ссылку в `README.md` проекта (строка «Skill для агентов»). Сам файл отстал от кода: нет стадий, лимитов, кодов, формата записи и границы с osint-research.
3. `osint-research/SKILL.md` уже отсылает к `egoist-social-research` («prefer the available egoist-social-research skill»); правка не нужна.
4. Решить, чинить ли дефект раздела 4 в проекте Social MCP.

## 6. Проверочные запросы (12)

Оценка по описанию, без живой модели: **на живой модели не проверялось.** Колонка «Должен сработать» — моё ожидание по тексту описаний соседних skills.

| № | Запрос | Должен сработать | Замечание |
|---|---|---|---|
| 1 | «Спарси канал @durov и выгрузи посты в CSV» (Telegram) | egoist-social-research, ветка Telegram | «спарсить канал» близко к scrapling («спарсить сайт») и video-research («канал»); название платформы в первой фразе описания должно решить |
| 2 | «Найди в собранных выгрузках каналов всё про кибербезопасность и посчитай по месяцам» | egoist-social-research (records, stats) | sqlite/knowledge-retrieval — только если речь о другом хранилище |
| 3 | «Вступи в группу по инвайту t.me/+abc и собери сообщения» | egoist-social-research | ожидаемое поведение: инвайт отклоняется планом, вступление только `telegram_join_chat` по `policy.json`; без этого — остановка и вопрос владельцу |
| 4 | «Выгрузи последние посты профилей @a, @b, @c в X» | egoist-social-research, ветка X | |
| 5 | «Исследуй аккаунт X про компанию и дай сводку по неделям» | egoist-social-research, ветка X | граница с osint-research: аккаунт как источник постов, не проверка личности или компании |
| 6 | «Собери твиты по хэштегу #foo» | egoist-social-research, ветка X | в X хэштег-источников нет: skill должен честно сказать о пределе и предложить прежний `social_submit` (`search`) |
| 7 | «Спарси профиль openai в Instagram, 200 постов» | egoist-social-research, ветка Instagram | |
| 8 | «Собери посты по хэштегу #дизайн в Instagram» | egoist-social-research, ветка Instagram | хэштег-лента — выборка видимого, не вся история тега |
| 9 | «Достань все комментарии под постом в Instagram» | egoist-social-research | комментарии не реализованы: честный отказ, не обход |
| 10 | «Найди компанию в открытых источниках и проверь владельцев» | osint-research | отрицательный для нашего skill |
| 11 | «Напиши пост для канала о запуске продукта» | ни один из трёх (при «звучит как ИИ» — humanizer) | отрицательный: слово «канал» не должно включить egoist-social-research, оно не просит чтения источников |
| 12 | «Исправь CSS: кнопка уезжает на мобильном» | impeccable или diagnosing-bugs | отрицательный |

Оценка рисков срабатывания: слабое место — общие слова «спарсить», «канал» (scrapling, video-research, osint-research). Если на живой модели из 12 запросов окажется меньше 11 верных, план предлагает сгенерировать три тонких входа из одного шаблона; пока вариант не нужен.

## 7. Непроверенное и оговорки

- Поведение живого Social MCP и аккаунтов Relay не проверялось; всё сверено по исходникам Social MCP 1.1.0. Коды `TIMESTAMP_FILTER_UNSUPPORTED`, `EMPTY_SOURCE_NOT_CONFIRMED`, `DOM_SOURCE_UNSUPPORTED` и проверки `/challenge`, `/checkpoint` указаны как возможные по наборам кодов в `scheduler.mjs` и документу покрытия 1.4.x, не по свежим наблюдениям.
- Утверждения об условиях X, Instagram и Telegram в limits-and-risk.md — осторожные («могут запрещать»), условия платформ не открывались; их проверяет владелец.
- Сведения о покрытии Instagram (чтение reel, авторство в ленте профиля) взяты из `docs\account-research-coverage.md` (Relay 1.4.2/1.4.3), для текущей 1.6.x не пересматривались.
- Пропускная способность живых платформ не измерена; в skill числа скорости не обещаются.
- Скрипт `export_summary.py` проверен только на синтетических файлах; на реальной выгрузке не запускался.
- По ходу работы командой `git stash` я по ошибке спрятал свою же правку `docs/skill-routing.md` и сразу вернул `git stash pop`; список stash пуст, правка на месте и вошла в коммит. Чужих изменений в репозитории не было.
