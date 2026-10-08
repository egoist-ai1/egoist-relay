# Egoist Relay 1.7.0 — итог цикла «Lagom + надёжность + агентский слой»

7–8 октября 2026, ветка `lagom-redesign` (от снимка `329c397`, 1.6.1). Подробности по этапам — в `docs/lagom-redesign-2026-10-07/`: [PLAN](lagom-redesign-2026-10-07/PLAN.md), [RESEARCH](lagom-redesign-2026-10-07/RESEARCH.md), [AUDIT-FRONTEND](lagom-redesign-2026-10-07/AUDIT-FRONTEND.md), [AUDIT-BACKEND](lagom-redesign-2026-10-07/AUDIT-BACKEND.md), [BACKEND-FIXES](lagom-redesign-2026-10-07/BACKEND-FIXES.md), [STAGE-B](lagom-redesign-2026-10-07/STAGE-B.md), [STAGE-ICONS](lagom-redesign-2026-10-07/STAGE-ICONS.md), [STAGE-NATIVE-THEME](lagom-redesign-2026-10-07/STAGE-NATIVE-THEME.md), [MCP-STAGE-0-1](lagom-redesign-2026-10-07/MCP-STAGE-0-1.md), [MCP-STAGE-2](lagom-redesign-2026-10-07/MCP-STAGE-2.md), [QA-REPORT](lagom-redesign-2026-10-07/QA-REPORT.md).

## Что сделано

- **Дизайн:** Lagom Dark/Light основные темы; Onest, Unbounded, JetBrains Mono (кириллица, самохостинг); иконки Phosphor (244 из 435); цветовые литералы вне запретных зон −63 %; нативный фон WebView и тема окна синхронны с UI.
- **Доступность:** клавиатурная модель вкладок и rail, `role="status"` у тостов, видимый фокус, контраст 4,5:1 в проверенных состояниях, 200 % масштаб списка чатов, глобальный reduced-motion.
- **Backend:** `relay_inline_save_media` снова проходит ACL; загрузки Mini App ограничены (расширения, лимиты); повреждённый журнал уходит в карантин; исправлены четыре дефекта отправки в GramJS-клиенте; preflight сверяет команды с манифестом и capabilities.
- **Агентский слой:** Egoist Social MCP — оркестратор (SQLite, планировщик, политика, аудит); в Relay — `offsetDate`/`minId`, probe, прямой тракт байтов медиа с возобновлением; skill `egoist-social-research` в репозитории правил.

## Проверки (08.10.2026)

| Проверка | Результат |
|---|---|
| `npm run check` | 0 ошибок, 508 предупреждений stylelint (лимит 508) |
| `npm test` | 528 из 528 |
| `cargo test` | 147 пройдено, 1 тяжёлый тест вручную |
| Social MCP | 259 из 259 |
| `release:preflight` | пройден, 40 runtime-файлов |
| `tauri:build` | установщик собран (NSIS), SHA-256 в `release/1.7.0/SHA256SUMS.txt` |

## Не проверено

- Установщик не запускался; рендер в нативном WebView2, скринридеры, холодный старт.
- Кнопка «сохранить оригинал», отмена загрузок Mini App по лимиту, смена фона WebView без вспышки — только по коду и тестам.
- Живой пилот исследовательского моста на аккаунте Telegram (чек-лист в `MCP-STAGE-2.md`): скорость тракта байтов, реакция Telegram на параллель.
- `relay-frontend-benchmark`, `ui-regression`, `visual-audit`; окно 640 px при 200 % масштабе.
- Установщик не подписан; публикация и `git push` не выполнялись.

## Решения, принятые за владельца (08.10.2026, все обратимы)

1. Десять прежних тем остаются как «прежние»; удаляются только отдельным решением.
2. Исходящий пузырь — ступень графита (не инверсия): инверсия плохо читалась в рендере.
3. Цвета пиров нейтральны в тёмных темах и цветные в светлых; не унифицируем, пока нет жалоб.
4. Social MCP: код `RATE_LIMITED` (совместим с установленным демоном), параллелизм 2, предел файла 1 ГиБ, spool на системном диске с настройкой пути.
5. «Asynth» = асинхронный массовый парсинг; вступление в группы и чтение личных диалогов по умолчанию запрещены политикой, включаются явно; один skill `egoist-social-research`.
6. Следующие циклы: слияние upstream Web A (layer 229), живой пилот моста, RS-04 (журнал с UI-потока), мультиаккаунтный пул.
