# Egoist Relay 1.4.7: публикация и локальное обновление

[Установщик Windows x64](https://github.com/egoist-ai1/egoist-relay/releases/download/relay-v1.4.7/Egoist-Relay-1.4.7-x64-setup.exe) опубликован в [GitHub release](https://github.com/egoist-ai1/egoist-relay/releases/tag/relay-v1.4.7). Размер: 567280908 байт. SHA-256: `df28147ec2293d56f0139131df013f0b44ed29723151b0c39cb96e779e66de1f`. Публичная ссылка возвращает HTTP 200 без авторизации; размер файла совпадает.

Канонический установщик обновил существующую установку 1.4.6 до 1.4.7 в `C:\Users\Egoist\AppData\Local\Egoist Relay` через `/S /UPDATE /NS`, exit code 0. Удаление приложения и профиля не выполнялось. Каталог профиля сохранил прежнюю дату создания; содержимое профиля не читалось, неизменность его байтов не утверждается.

EXE: версия 1.4.7, SHA-256 `68ce83b8e12162a56fcfa2a801e0551ba3ff653b63ad829fbce657cbccc7baf7`; все 40 runtime файлов совпали по размеру и SHA-256. Приложение запущено с `--start-hidden`, PID 3020, точный путь и время запуска проверены. Реальные действия в аккаунтах не выполнялись.

По прямому запросу владельца установщик опубликован при неполном inventory исходников зависимостей. Поля correspondingSourceComplete=false и publicationBlocked=true в исходном inventory сохранены; они не означают отсутствие уже опубликованного файла. Статус GitHub остаётся prerelease, установщик неподписан.

Evidence: [публикация](installer-publication.json), [доступность](public-installer-download.json), [локальное обновление](local-reinstall.json).
