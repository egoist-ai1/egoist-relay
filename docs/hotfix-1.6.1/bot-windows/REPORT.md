# Relay 1.6.1: Windows Mini App и окна магазинов

На `shop.ixbt.app` подтверждён отдельный запрет iframe: публичный HEAD от 6 октября 2026 вернул HTTP 200 и `Content-Security-Policy: frame-ancestors 'none'`. Сеть доставила ответ, но текущий WebAppTab открывал сайт в iframe. Изменение прокси не отменяет этот серверный запрет. [Публичные headers](shop-public-headers.json), [сайт](https://shop.ixbt.app/).

Windows Mini App теперь открывается верхним документом отдельного child WebView2 в области существующей вкладки. Telegram URL с InitData остаётся внутри приложения; его параметры не выводятся в журнал, не сохраняются в реестр операций и не передаются в системный браузер. Другие платформы сохраняют прежний iframe путь. Для открывающихся до измерения вкладок используется скрытый 1×1 view; активная вкладка показывается после загрузки и корректного измерения.

## Контракт и proxy path

`relay_mini_app_open/update/reload/send/close` доступны только локальному главному WebView. Имена `mini-app-<UUID>` и `mini-app-popup-<UUID>` не совпадают с UUID allowlist обычных Telegram окон. И remote content, и popup не получают новую capability Relay. Native Mini App принимает credential-free HTTPS URL с ограничением 64 KiB; исходящий event ограничен 1 MiB. Произвольные HTTP/file/javascript/data источники отвергаются.

Main host и внешний Mini App обмениваются Telegram WebApp событиями через native `TelegramWebviewProxy`/WebView2 message channel. Сессия имеет случайный ID и nonce; native проверяет текущий верхний URL, origin исходного приложения, номер текущей навигации и готовность документа. Старый NavigationCompleted и поздние события не относятся к новому документу. После cross-origin redirect host events не принимаются и privileged ответы не доставляются. JavaScript bridge запускается только в top document; COM callbacks и их освобождение выполняются на UI thread.

Native `open` — async command: vendor Tauri `Window::add_child` делает dispatch на main thread и синхронно ждёт результат. Синхронный IPC creation на Windows мог зависнуть. Всплывающие окна используют штатный `NewWindowResponse::Create` и `window_features(features)`: vendored Tauri копирует точный WebView2 environment opener, а Wry 0.57.0 использует GetDeferral и переносит creation за текущий COM callback. Обычные `window.opener` и POST popup bootstrap сохраняются. Допускаются HTTPS и ровно `about:blank` bootstrap. Popup имеет стандартную системную рамку, принадлежит main window, скрывается с вкладкой и уничтожается при её закрытии; до 8 popup на вкладку. Вложенные popup сейчас запрещены.

`open_new_window_cmd` существующего Relay предназначен для навигации локального главного окна и не подходит для внешнего popup: он не сохраняет browser opener/environment контракт. Поэтому используется отдельный native маршрут.

Новый Mini App не устанавливает `proxy_server`, не вычисляет отдельный DIRECT маршрут и не изменяет аргументы браузерного движка. Документ, subresources и owned popup наследуют текущую Windows/WebView2 network policy. Native WinHTTP resolver медиатранспорта (`system_proxy.rs`) не изменён и не подменяет браузерный proxy path. Настройки Windows/Lagom, CSP и TLS не менялись. Эта проверка подтверждает путь в коде; фактический PAC/proxy route на устройстве пользователя пока не измерен.

## Проверки и границы

- Один TypeScript `tsconfig.json`: exit 0. Affected ESLint: exit 0, 0 ошибок и предупреждений, heap 5120 MiB, кэш в own task work.
- Adapter lifecycle: 7/7. Покрыты сохранение исходного fragment, active/covered state, скрытая геометрия, переключение без пересоздания, cancel late creation, один close, manual reload и late events.
- Injected bridge: 4/4, включая настоящий официальный TelegramMessenger SDK из exact commit `e086c60734519ff816c3af5cf95def3edd7d12fc`. Проверены top document / platform=weba / synthetic InitData / ready / theme / viewport / receiveEvent / close. SHA-256 и источник в [sdk-source.json](sdk-source.json). Прямой served URL telegram.org был недоступен; проверен опубликованный upstream SDK, не утверждается идентичность текущему served JS.
- Настоящие App/WebAppTab/hooks в headless Edge с изолированным NativeMock: 9 успешных assertions, page errors 0, unhandled 0. Placeholder about:blank, native URL payload, loaded/error, protocol replies, tab switch, Ctrl+J с настоящей панелью, возврат, Escape и late dispose. Внешние запросы запрещены runner. UI reload menu в этой fixture не проверен; adapter reload проверен отдельно.
- Root сохранил 3/3 проверок exact native production helpers в [native guards](../native-guards/mini-app-guards.json) и сообщил об успешной окончательной production-компиляции frozen исходников. NSIS/installer относятся к общему release receipt root.

Mock bridge не доказывает фактическую загрузку WebView2, proxy/PAC, popup opener или native keyboard. Живые аккаунты, InitData пользователей, отправки, покупки, DPI/GPU и второе устройство не использовались. CSP/TLS не отключались. Серверные отказы, истёкший InitData и неподдерживаемые действия конкретного магазина остаются возможными и требуют живой приёмки.

## Файлы и продолжение

[Scoped diff](changes-from-1.6.0.patch) и [hashes](source-diff.json) основаны на exact before bytes 1.6.0 перед собственными правками; root CSS/version в них не входят. `baseline/` сохраняет эти собственные исходники, а `source-diff.json` отмечает новые файлы. Patch нормализует переносы строк для Git; byte hashes фиксируют настоящие bytes. [Verification](verification.json) и [integration evidence](integration-smoke.json) разделяют unit, real JSX, native compilation и непроверенное.

Для безопасной пользовательской приёмки: открыть тот же бот/магазин в новом Relay, проверить его загрузку, переходы между вкладками, обычное обновление, закрытие, Ctrl+J и возврат. Popup должен сохранить исходную вкладку и закрыться вместе с ней. Платёж и отправка данных агентом не выполнялись. Устройство с фактически настроенным Windows/PAC proxy нужно отдельно для проверки его маршрута.

[Review board](review.html) имеет нейтральные ответы. Подтверждение означает принятие вывода/границы отчёта и обсуждение комментария; оно не запускает публикацию, покупку, изменение Windows settings или действие в Telegram.
