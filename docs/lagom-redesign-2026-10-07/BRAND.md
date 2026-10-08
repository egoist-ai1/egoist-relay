# Бренд: Sennit (by Egoist)

8 октября 2026, ветка lagom-redesign, 1.7.0. Подробности: [NAMING](../brand/NAMING.md), [BRAND](../brand/BRAND.md), контрольный лист [preview.png](../brand/preview.png).

## Итог

- **Имя: Sennit** (подпись «by Egoist»). Шесть кандидатов (Sennit, Skein, Strand, Cairn, Plait, Weft); поиск показал занятость у пяти, у Sennit совпадений нет. Метафора — шнур из прядей, три сервиса в одном плетении. Приставку «Egoist» убрали из названия, родство — в подписи.
- **Знак:** S из трёх полос с просветами на изгибах. Монохром graphite-100/900, Lagom. Файлы: `docs/brand/mark.svg`, `mark-light.svg`, `wordmark.svg`, `lockup.svg`, `app-icon.svg` (+ `-light`).
- Проверка: SVG растеризованы headless Chromium (Playwright) на 16/24/32/48/256 px, тёмная и светлая темы, осмотрено глазами; S читается с 16 px, просветы на 16–24 px сливаются, форма остаётся.

## Что изменено

| Область | Что |
|---|---|
| Окно и Titlebar | заголовок окна `Sennit` (`tauri.conf.json`, `lib.rs`, `PAGE_TITLE_TAURI`); в Titlebar знак `SennitMark` и строка `RelayBrand = Sennit` |
| Строки | `fallback.strings`, `initialRussian.strings`, `initialStrings.ts`: «внутри Sennit», «приложении Sennit», `RelayBrand`; ключи не менялись, `lang:ts` не нужен |
| Меню в боковой панели | `APP_NAME` по умолчанию `Sennit` (подвал меню, заголовки уведомлений) |
| Трей | подписи «Открыть Sennit» / «Выйти из Sennit» (`tray/mod.rs`) |
| Иконки приложения | `tauri/icons`: ico, icns, png (32/64/128/128@2x/icon.png) и `macos/`, сгенерированы `npx tauri icon` из 1024 px; значок трея на Windows берёт `32x32.png` |
| Установщик NSIS | `nsis-header.bmp`, `nsis-sidebar.bmp` новые; сообщения в `installer.nsh` («Sennit требует…», «Закройте Sennit…»); `DisplayName=Sennit` в разделе «Приложения и возможности» (POSTINSTALL) |
| Веб-часть | favicon.svg, favicon-unread.svg, favicon-16/32, icon-192/384/512 (и dev/square), apple-touch-icon, mstile; `site*.webmanifest` name/short_name; `installer.html` (тексты) |
| Тексты | README, шапка `docs/DESIGN.md`, `package.json` description, `copyright`/описания Tauri, `Cargo.toml` description |
| Новое | `src/components/common/SennitMark.tsx`, `docs/brand/*` |

## Что оставлено прежним и почему

Внутреннее имя продукта `Egoist Relay` (`productName`, `mainBinaryName`) **не менялось**. От него зависят:

- имя `Egoist Relay.exe` и папка установки `...\Programs\Egoist Relay`; смена приведёт к установке рядом и двум программам;
- ключ деинсталляции `UNINSTKEY` (из productName): новый ключ не увидит старую версию, защита от понижения версии и обновление «поверх» перестанут работать;
- `installer-processes.ps1` (путь к exe), `launch.bat`, `tauri/src/installer.rs` (ярлыки, exe), тест `instagram-attribution-audit.test.mjs` (путь установки), user-agent в `system_proxy.rs`;
- `scripts/release-policy.mjs` (`PRODUCT.name` проверяется preflight);
- `identifier` `com.egoist.relay` (AppData, профили WebView2), named pipe и Relay Control API, ключи хранилищ, пути Social MCP.

Ярлыки Рабочего стола и меню «Пуск» создаёт Tauri по `productName`, поэтому они пока называются «Egoist Relay» (иконка новая). Переименовать их без смены productName можно только дописав в `installer.nsh` перенос ярлыков и очистку в PREUNINSTALL; не сделано, потому что установщик не собирался и не проверялся.

## Для полного переименования exe и папки (отдельный этап, нужно решение владельца)

1. Сменить `productName` и `mainBinaryName` на `Sennit`, `PRODUCT.name` в `release-policy.mjs`, тесты политики.
2. В `installer.nsh` добавить миграцию: найти старый ключ `Egoist Relay`, остановить процесс, удалить старую установку (данные в AppData не трогать, `identifier` остаётся), перенести ярлыки.
3. Обновить `installer-processes.ps1`, `launch.bat`, путь в `instagram-attribution-audit.test.mjs`, пути Social MCP и skill `egoist-social-research`.
4. Собрать установщик и проверить обновление поверх 1.7.0 на копии профиля.

## Термин «Relay» оставлен: места для следующего этапа

- Ключи локализации `Relay*` (внутренние, пользователю не видны); нейминг кода `relay-*` в `scripts/`, тесты `relay-*.test.mjs`.
- Relay Control API, именованные каналы, `EGOIST_RELAY_*` переменные, `__egoistRelay*` в странице.
- «Аккаунты Relay» в skill `egoist-social-research`, Social MCP и его документации; `runtime/research/*`.
- `docs/*` прошлых версий, `package.json` name `egoist-relay`, репозиторий `egoist-ai1/egoist-relay`.
- Текст ошибки `RELAY_EXIT_REQUIRED` в `installer-processes.ps1` (англ., служебный).

## Не сделано

- Rail (AppSidebar) и экран входа: знак не добавлен, потому что стили компонентов в `src/components/**.scss` сейчас правит другой агент; готовый `SennitMark` можно вставить в `AppSidebar`/экран входа после слияния. На экране входа Telegram, вероятно, остаётся логотип Telegram Web A (проверьте до публикации).
- `tray-macos.png` (шаблон macOS) не перерисован; Windows использует `32x32.png`.
- Описание Telegram Web в `site*.webmanifest` (description) не менялось.

## Проверки

| Проверка | Статус |
|---|---|
| `npx tsc` | [проверено] без ошибок |
| `npm test` (vitest) | [проверено] 49 файлов, 594 теста |
| eslint (SennitMark.tsx, Titlebar.tsx, config.ts) | [проверено] без замечаний |
| `npm run release:preflight` | [проверено] проходит (1.7.0, 40 файлов runtime), имя продукта не менялось |
| `node --test scripts/release-policy.test.mjs` | три теста требуют `EGOIST_RELAY_AUDIT_WORK` (среда), к бренду не относятся; остальные проходят |
| Рендер SVG 16–256 px | [проверено] глазами |
| NSIS-установщик, мастер, DisplayName, нативные иконки Windows/трей | [не проверено] не собирались |
| Домены, магазины приложений, товарные знаки | [не проверено] |
