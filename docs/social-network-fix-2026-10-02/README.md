# Relay: загрузка X и Instagram

X и Instagram загружаются в обновлённом Relay: подтверждены текущими native UI ready-состояниями и пользователем. Добавлена обработка семи доменов в действующем winws и узкая обработка CDN только в профиле X; настройки устройства и приоритеты Lagom сохранены.

Добавлены семь доменов в действующий winws. В профиле X Relay два CDN используют DNS alias ton.twimg.com через текущий DNS/DoH. Исходные URL и проверка TLS сохраняются; глобальные DNS и hosts не менялись.

Проверка готовности начинается на DOMContentLoaded и принимает только сообщение текущего документа с правильным token, NavigationId, origin и source. Ошибки навигации и предел 45 секунд сохранены. Telegram bridge проверен публичным чтением одного сообщения.

Сохранность настроек: {"checkedAt":"2026-10-02T04:29:58.0110625+03:00","systemDnsUnchanged":true,"relayProfilesUnchanged":true,"dohProfileUnchanged":true,"serviceXmlUnchanged":true,"exclusionsUnchanged":true,"zapretSameRunningProcess":true,"dohSameRunningProcess":true}.

Сборка: 820e5e814a3029db3b6929d49d3ad56646488ad46419768d61f4407fa6cb3b7c. Native suite: 15 passed, 0 failed.

Реальные проверки: [verification.json](verification.json), [hostlist receipt](hostlist-receipt.json). Отдельная [форма обратной связи](review.html). Подтверждение в форме принимает показанный результат; оно не запускает новую настройку DNS или автоматический откат.

Флаг host-resolver-rules зависит от Chromium/WebView2; Microsoft рекомендует проверять совместимость и не считает browser flags стабильным интерфейсом для production. После обновления runtime потребуется повторная проверка: [WebView2 browser flags](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags). Механизм alias разрешения описан в [MappedHostResolver Chromium](https://chromium.googlesource.com/chromium/src/+/main/net/dns/mapped_host_resolver.cc).
