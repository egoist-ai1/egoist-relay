# Скрытый запуск Relay — read-only уточнение

Root установил проверенный Setup и сообщил visible=true для main30140 в13:42:56Z. Прямой CIM readback этого же PID подтвердил точный установленный путь, birth13:40:39.723203Z и наличие реального `--start-hidden`; полный command line не выводился. Код и установленный экземпляр данный аудит не менял.

В `lib.rs:128` hidden-флаг входит в should_avoid_foreground. Построение main visible/focusedfalse (`:489`) и open_new_window show (`:477`) учитывают этот guard; deep links тоже. ActivateTelegram в `multi_app.rs:522` не вызывает main.show. Hidden prewarm создаёт child WebViews; локальный первоисточник Wry0.57 управляет их дочерним HWND. Plugin single-instance2.4.3 сам не показывает окно. Frontend App/Titlebar/initTauri не вызывает window.show на старте.

Явные unguarded main.show — `lib.rs:201` после обычного второго запуска и `tray/mod.rs:137` после tray click/Open. Они нужны для пользовательского открытия работающего фонового приложения. Оба события сейчас не журналируются, поэтому поздний visible=true не позволяет доказать, был ли user-open или ошибка начального скрытия. Подтверждённого автоматического unguarded startup.show пути в ограниченном аудите не найдено. Пересборка без причины не выполнялась.

NSIS GUI RunMainBinary (`generated-installer.nsi:414`) запускает без аргументов; silent/passive запускает приложение лишь с `/R` (`:763`). Объяснять30140 одним installerautorun нельзя: фактический hidden-флаг у выбранного процесса присутствует. Existing native `relay_control_status` (`lib.rs:134`) сообщает ENVbackground; requested-hidden не предоставляет. Named-pipe research API не разрешает произвольный eval/управление окном.

Безопасное существующее скрытие, если Root считает его необходимым: WM_CLOSE к актуальному, непосредственно сверённому собственному main HWND. Handler `lib.rs:221` сохраняет url, скрывает окно и предотвращает завершение; transport workers остаются. Это не подтверждение исходного hidden-start и не требует рестарта DNS/Relay.

Первопричина видимости остаётся не установленной по имеющимся событиям. Рабочий TG bridge и факт наличия hiddenargument можно подтвердить независимо; их не следует смешивать с принятой проверкой видимости при загрузке Windows. [Структурированный снимок](hidden-start-source-audit.json), [Root readback](installed-process-readback.json), [механизмы управления](installation-semantics.md).

## Уточнение после аудита

Пользователь прямо ответил «Да, открывал сам» на вопрос об открытии окна после установки. Поздняя видимость объясняется этим действием и не является свидетельством самопроизвольного foreground startup. [Root readback worker и Startup](installed-worker-payload-readback.json) подтверждает реальный hidden-аргумент и ярлык. Немедленная видимость после запуска и следующий вход в Windows отдельно не наблюдались. Приложение не скрывалось повторно и не перезапускалось. Предыдущий текст сохранён как ход read-only аудита; открытый вопрос разрешён ответом пользователя.
