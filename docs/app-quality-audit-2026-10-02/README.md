# Egoist Relay: узкий audit 1.4.6

Relay 1.4.6 установлен по свежему явному разрешению и обычному закрытию приложения. Canonical пакет, EXE и 40 runtime файлов подтверждены. Telegram и X готовы; пользователь подтвердил Instagram ленту под своим аккаунтом, но официальный Instagram MCP пока unavailable / dom_account_proof_pending. Полный аудит приложения остаётся незавершённым.

Новый объём: вертикальный rail Reels, буквальная подпись **Нравятся** с сохранением числовых счётчиков и SocialShareModal в стиле Telegram. [Alignment v2](reel-actions-alignment-1.4.6-v2.json) проверен на exact source 17ec: 4/4 синтетических сценария. Дополнительный DOM placeholder rerender сохраняет numeric 17, cleanup удаляет только собственные классы. Старый v1 исключён из текущей acceptance.

[Окончательный диалог](telegram-share-native-format-1.4.6.json) содержит точные geometry/callback проверки, включая короткий viewport. [Пакет 1.4.6](../release-1.4.6/README.md) отдельно показывает сборку и фактическую установленную версию. Все 115 объектов нейтральны; предыдущие 109 сохранены точно. Разрешение установки 1.4.5 не переносится на 1.4.6.

Прежний [audit-2](archive/1.4.5-candidate-audit-2/archive-manifest.json) сохранён побайтно. Результаты 1.4.3 обозначены как проверенные исторические подмножества. Состав freeze 1.4.5: 8 production + 6 metadata = 14; runtime helper является отдельной записью внутри 40 runtime файлов.

Native Instagram pilot 1.4.5 остаётся interrupted/DEADLINE 45s, accepted 0, outcome partial. Эта задача не повторяла чтение и не запускала реальные сообщения, платежи или private DM. Native DPI, CDN/live upload и полнота всех 138 категорий сохраняют прежние gates. Готовность трёх existing-account bridges в 1.4.5 остаётся историческим bounded receipt. В установленной 1.4.6 готовы Telegram и X; Instagram UI подтверждён пользователем, но официальный Instagram MCP остаётся dom_account_proof_pending. Текущий MCP source hash подтверждён отдельно; это не доказательство успешного research чтения. Текущий source freeze 1.4.6: 3307 inputs, 4 production UI + 5 metadata = 9 изменений, 34 frozen owned hashes и 40 runtime files. TypeScript main/test/script: exit 0; Vitest: 26 suites / 322 PASS. Это проверка исходников и выбранных локальных сценариев.

[Требования](requirements.json) · [Проверки](validation-summary.json) · [Review board](review.html) · [Точный снимок](Реестр.json).
