# Приватность и сообщения о проблемах

В source publication запрещены реальные аккаунтные сессии, cookies, WebView profiles, auth keys, access/refresh tokens, Telegram API credentials, .env, DPAPI blobs, private exports и пользовательские DNS/proxy configurations. Source snapshot переносится из allowlist; старые локальные commits не публикуются. Тестовые данные синтетические.

Для собственного запуска авторизация создаётся пользователем на его устройстве. API credentials используются только из локального developer environment. Research интерфейс не предоставляет произвольные native/browser calls и не отправляет сообщения, не ставит реакции, не публикует посты и не меняет аккаунтные настройки.

При сообщении о проблеме укажите версию, воспроизводимые шаги и обезличенный код ошибки. Не публикуйте session files, cookies, токены, API hash, личную переписку или DNS enrollment IDs в Issues.
