# Узкое предложение по атрибуции Instagram

Это reviewable diff, не применённое исправление. Производственные файлы и замороженная версия не изменялись; предложенный код не запускался.

[instagram-attribution-proposal.patch](instagram-attribution-proposal.patch) содержит три узких изменения: строгое сравнение того же Instagram post locator для OG-caption fallback; явный sourceContext/pageMetadata с дополнительной native проверкой фактического документа; исключение явно помеченной биографии страницы из FTS содержания нового post/reel.

Поле description сохраняется для совместимости и прямо маркируется как page metadata. Оно не становится подписью поста лишь из-за нахождения в записи reel. Отдельные post evidence — исходный наблюдённый permalink, text из h1/OG только для этого же поста, time[datetime] и сырой observedText заголовка. Publisher/collaborators не выводятся из URL и остаются непроверенными.

Новые поля необязательны для старых записей. Bridge-provider сохраняет дополнительные поля; compact MCP/broker контракты не меняются. В новом native guard контекст должен совпадать с уже проверенным event.pageUrl и выбранным target; прежние origin/account/epoch/source ограничения сохраняются. pageMetadata.descriptionField ссылается на flat description, не дублируя большой текст в ограниченных frames.

Старые результаты не переписываются. FTS для старых записей не может автоматически определить происхождение biography задним числом. Нужны отдельные проверки textFields/частей больших записей, чтобы метаданные страницы не попали в объединённый content text. Это явный дополнительный gate, а не проверенная здесь гарантия.

Baseline/proposed SHA, точная роль каждого поля, совместимость и проверки перед возможным применением: [instagram-attribution-proposal.json](instagram-attribution-proposal.json). Оба исходных before failures сохранены в [instagram-attribution-test-receipt-v3.json](instagram-attribution-test-receipt-v3.json).
