// Relay owns these strings; provider language packs do not contain them.
import type { LangKey } from '../../types/language';

const russian: Partial<Record<LangKey, string>> = {
  RelayMiniAppLoadFailed: 'Мини-приложение не загрузилось. Обновите вкладку и проверьте соединение '
    + 'и текущий прокси Windows.',
  RelayThemeVariants: 'Темы',
  RelayThemeDark: 'Тёмные темы',
  RelayThemeLight: 'Светлые темы',

  RelayOperationSaveAgain: 'Сохранить набор заново',
  RelayOperationSaveRecovery: 'Сохраним свежий набор отдельной операцией. Ранее сохранённые файлы останутся в истории.',
  RelayOperationMore: 'Показать ещё',
  RelayOperationRecoveryHelp: 'Продолжение прежней операции. Получатель и формат сохраняются. Новый набор проверим '
    + 'до отправки. Подтверждённые сообщения пропустим.',
  RelayOperationRecaptureHelp: 'В публикации снова выберите «Поделиться в Telegram». Проверим свежий набор перед '
    + 'повтором.',
  RelayOperationTitle: 'Загрузки и пересылки',
  RelayOperationCurrent: 'Текущие',
  RelayOperationHistory: 'История',
  RelayOperationClose: 'Закрыть панель',
  RelayOperationBack: 'Вернуться к сервису',
  RelayOperationEmptyCurrent: 'Сейчас нет активных операций. Завершённые файлы и пересылки доступны в истории.',
  RelayOperationEmptyHistory: 'Здесь появятся сохранённые файлы и результаты пересылок. Журнал хранится на этом '
    + 'компьютере 30 дней.',
  RelayOperationLocked: 'Разблокируйте Telegram, чтобы посмотреть журнал. Следующая пересылка начнётся после '
    + 'разблокировки.',
  RelayOperationPrivacy: 'Локальный журнал · 30 дней · до 500 завершённых операций',
  RelayOperationClear: 'Очистить историю',
  RelayOperationClearHelp: 'Очистка удаляет записи журнала. Сохранённые файлы остаются в папке загрузок.',
  RelayOperationClearConfirm: 'Очистить записи',
  RelayOperationQueued: 'В очереди',
  RelayOperationResolving: 'Определяем источник и маршрут',
  RelayOperationDownloading: 'Скачиваем',
  RelayOperationWriting: 'Проверяем и сохраняем',
  RelayOperationPreparing: 'Готовим вложения',
  RelayOperationSending: 'Ожидаем подтверждения Telegram',
  RelayOperationCancelling: 'Останавливаем оставшиеся шаги',
  RelayOperationCompleted: 'Готово',
  RelayOperationFailed: 'Не удалось завершить',
  RelayOperationCancelled: 'Отменено',
  RelayOperationInterrupted: 'Прервано. Можно проверить источник и повторить.',
  RelayOperationUncertain: 'Исход неизвестен',
  RelayOperationUncertainHelp: 'Проверьте чат в Telegram. Автоматического повтора нет; уже подтверждённые сообщения '
    + 'остаются у адресата.',
  RelayOperationSave: 'Сохранение',
  RelayOperationSend: 'Пересылка',
  RelayOperationDownload: 'Загрузка',
  RelayOperationUnknownFile: 'Медиа из публикации',
  RelayOperationUnknownSource: 'Исходное сообщение не определено',
  RelayOperationOpen: 'Открыть файл',
  RelayOperationReveal: 'Показать в папке',
  RelayOperationSource: 'К источнику',
  RelayOperationChat: 'Проверить чат',
  RelayOperationRetry: 'Повторить',
  RelayOperationCancel: 'Отменить',
  RelayOperationMissingFile: 'Файл перемещён или удалён. Запись в журнале не восстанавливает файл.',
  RelayOperationCancelHelp: 'Остановим оставшиеся элементы. Уже подтверждённые сообщения не отзываются.',
  RelayOperationConfirmed: 'Подтверждено',
  RelayOperationItem: 'Элемент',
  RelayOperationAttempt: 'Попытка',
  RelayOperationModeLink: 'Ссылка',
  RelayOperationModeMedia: 'Медиа',
  RelayOperationModeFile: 'Файл',
  RelayOperationLinkHelp: 'Адресат получит ссылку и доступный текст публикации.',
  RelayOperationMediaHelp: 'Обычные фото и видео Telegram. Полученная версия может отличаться от оригинала '
    + 'исходной платформы.',
  RelayOperationFileHelp: 'Передадим полученные байты файлом без своей перекодировки. Это версия, доступная у '
    + 'исходной платформы.',
  RelayOperationAccepting: 'Добавляем операцию в очередь…',
  RelayOperationQueueFull: 'Очередь заполнена: одна операция выполняется, восемь ожидают. Дождитесь результата '
    + 'или отмените лишнюю.',
  RelayOperationJournalError: 'Журнал недоступен. Исходный повреждённый файл сохранён для восстановления. Новую '
    + 'операцию можно начать после устранения ошибки.',
  RelayOperationAccountChanged: 'Эта пересылка относится к другому аккаунту Telegram. Повтор в текущем аккаунте '
    + 'заблокирован.',
  RelayOperationSourceChanged: 'Источник или набор вложений изменился. Откройте публикацию и подготовьте новую '
    + 'пересылку с проверкой адресата.',
  RelayOperationRecapture: 'Для этого набора откройте источник и выберите медиа заново. Старые подтверждённые '
    + 'сообщения не повторяются автоматически.',
  RelayOperationPriceChanged: 'Стоимость сообщения изменилась. Для платной отправки откройте источник и '
    + 'подтвердите её в диалоге.',
  RelayOperationLimit: 'Пересылка: до 64 МиБ на файл, 128 МиБ на набор и 10 вложений.',
  RelayOperationDiskFull: 'На диске недостаточно места. Освободите место и повторите.',
  RelayOperationTimeout: 'Истёк срок операции. Проверьте соединение и источник перед повтором.',
  RelayOperationProxy: 'Не удалось определить маршрут прокси. Проверьте действующие настройки Windows.',
  RelayOperationUnavailable: 'Источник недоступен или ссылка истекла. Откройте публикацию для получения свежих данных.',
  RelayOperationError: 'Не удалось выполнить действие. Повторите после проверки источника и соединения.',
  RelayOperationJournalWarning: 'Не удалось записать результат в защищённую историю. '
    + 'Он доступен, пока приложение открыто. После перезапуска проверьте файл или чат.',
  RelayOperationQueuedNotice: 'Задача добавлена. Ход и результат доступны в «Загрузках и пересылках».',
};
const english: Partial<Record<LangKey, string>> = {
  RelayMiniAppLoadFailed: 'The mini app could not load. Refresh the tab and check the connection '
    + 'and current Windows proxy.',
  RelayThemeVariants: 'Themes',
  RelayThemeDark: 'Dark themes',
  RelayThemeLight: 'Light themes',

  RelayOperationSaveAgain: 'Save the set again',
  RelayOperationSaveRecovery: 'Save the fresh set as a separate operation. Previous saved files stay in History.',
  RelayOperationMore: 'Show more',
  RelayOperationRecoveryHelp: 'Continue the previous operation. Recipient and format stay fixed. We check the '
    + 'fresh set before sending and skip acknowledged messages.',
  RelayOperationRecaptureHelp: 'Select Share to Telegram on the post again. We check the fresh set before retrying.',
  RelayOperationTitle: 'Downloads and transfers',
  RelayOperationCurrent: 'Current',
  RelayOperationHistory: 'History',
  RelayOperationClose: 'Close panel',
  RelayOperationBack: 'Return to service',
  RelayOperationEmptyCurrent: 'No active operations. Find saved files and transfers in History.',
  RelayOperationEmptyHistory: 'Saved files and transfer results appear here. This computer keeps the journal for '
    + '30 days.',
  RelayOperationLocked: 'Unlock Telegram to view the journal. The next transfer waits until you unlock.',
  RelayOperationPrivacy: 'Local journal · 30 days · up to 500 completed operations',
  RelayOperationClear: 'Clear history',
  RelayOperationClearHelp: 'Clearing removes journal entries. Saved files stay in your downloads folder.',
  RelayOperationClearConfirm: 'Clear entries',
  RelayOperationQueued: 'Queued',
  RelayOperationResolving: 'Resolving source and route',
  RelayOperationDownloading: 'Downloading',
  RelayOperationWriting: 'Checking and saving',
  RelayOperationPreparing: 'Preparing attachments',
  RelayOperationSending: 'Waiting for Telegram acknowledgement',
  RelayOperationCancelling: 'Stopping remaining steps',
  RelayOperationCompleted: 'Completed',
  RelayOperationFailed: 'Could not complete',
  RelayOperationCancelled: 'Cancelled',
  RelayOperationInterrupted: 'Interrupted. Check the source before retrying.',
  RelayOperationUncertain: 'Outcome unknown',
  RelayOperationUncertainHelp: 'Check the Telegram chat. There is no automatic retry; acknowledged messages stay '
    + 'with the recipient.',
  RelayOperationSave: 'Save',
  RelayOperationSend: 'Transfer',
  RelayOperationDownload: 'Download',
  RelayOperationUnknownFile: 'Media from post',
  RelayOperationUnknownSource: 'Original message is unknown',
  RelayOperationOpen: 'Open file',
  RelayOperationReveal: 'Show in folder',
  RelayOperationSource: 'Go to source',
  RelayOperationChat: 'Check chat',
  RelayOperationRetry: 'Retry',
  RelayOperationCancel: 'Cancel',
  RelayOperationMissingFile: 'The file was moved or deleted. A journal entry cannot restore it.',
  RelayOperationCancelHelp: 'Stop remaining items. Acknowledged messages will not be recalled.',
  RelayOperationConfirmed: 'Acknowledged',
  RelayOperationItem: 'Item',
  RelayOperationAttempt: 'Attempt',
  RelayOperationModeLink: 'Link',
  RelayOperationModeMedia: 'Media',
  RelayOperationModeFile: 'File',
  RelayOperationLinkHelp: 'The recipient receives a link and the available post text.',
  RelayOperationMediaHelp: 'Standard Telegram photos and videos. The fetched version may differ from the source '
    + 'platform original.',
  RelayOperationFileHelp: 'Send the fetched bytes as a file without our own re-encoding. This is the version '
    + 'available from the source platform.',
  RelayOperationAccepting: 'Adding operation to queue…',
  RelayOperationQueueFull: 'The queue is full: one operation is running and eight are waiting. Wait or cancel one.',
  RelayOperationJournalError: 'The journal is unavailable. The original damaged file is preserved for recovery. '
    + 'Resolve the error before starting another operation.',
  RelayOperationAccountChanged: 'This transfer belongs to another Telegram account. Retry is blocked in the current '
    + 'account.',
  RelayOperationSourceChanged: 'The source or attachment set changed. Open the post and prepare a new transfer, '
    + 'checking the recipient.',
  RelayOperationRecapture: 'Open the source and select this media set again. Previous acknowledged messages are '
    + 'not repeated automatically.',
  RelayOperationPriceChanged: 'The message price changed. Open the source and confirm any paid send in the dialog.',
  RelayOperationLimit: 'Transfer limits: 64 MiB per file, 128 MiB per set and 10 attachments.',
  RelayOperationDiskFull: 'Not enough disk space. Free some space and retry.',
  RelayOperationTimeout: 'The operation timed out. Check the connection and source before retrying.',
  RelayOperationProxy: 'The proxy route could not be resolved. Check the current Windows settings.',
  RelayOperationUnavailable: 'The source is unavailable or expired. Open the post to obtain fresh data.',
  RelayOperationError: 'The action failed. Check the source and connection before retrying.',
  RelayOperationJournalWarning: 'The result could not be written to the protected journal. '
    + 'It remains available while the app is open. After restarting, check the file or chat.',
  RelayOperationQueuedNotice: 'Task added. Find progress and results in Downloads and transfers.',
};

export function getRelayOperationString(key: LangKey, langCode = 'ru'): string | undefined {
  return langCode.startsWith('ru') ? russian[key] : english[key];
}
