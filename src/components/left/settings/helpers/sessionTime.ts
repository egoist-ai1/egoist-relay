// Время входа и активности сеанса: точная дата с секундами и относительная подсказка.
// Telegram отдаёт date_created / date_active только для ваших собственных сеансов.

const MS_IN_SECOND = 1000;
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

export type SessionTimeSource = {
  dateCreated?: number;
  dateActive?: number;
};

export type FormattedSessionTime = {
  text: string;
  ago: string;
};

/** Секунды Unix > 0 — валидное время; 0, undefined и NaN означают «Telegram не отдал». */
export function isValidSessionDate(unixSeconds?: number): unixSeconds is number {
  return typeof unixSeconds === 'number' && Number.isFinite(unixSeconds) && unixSeconds > 0;
}

/** «8 окт 2026, 14:23:07» — локальный часовой пояс, 24 часа. */
export function formatSessionDateTime(unixSeconds: number, langCode = 'ru', timeZone?: string) {
  const date = new Date(unixSeconds * MS_IN_SECOND);
  let datePart = new Intl.DateTimeFormat(langCode, {
    day: 'numeric', month: 'short', year: 'numeric', timeZone,
  }).format(date);
  if (langCode.startsWith('ru')) {
    datePart = datePart.replace(/\s*г\.$/, '').replace(/\./g, '');
  }
  const timePart = new Intl.DateTimeFormat(langCode, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone,
  }).format(date);

  return `${datePart}, ${timePart}`;
}

/** «3 дня назад» */
export function formatSessionAgo(unixSeconds: number, langCode = 'ru', nowMs = Date.now()) {
  const diff = Math.max(0, Math.round(nowMs / MS_IN_SECOND - unixSeconds));
  const formatter = new Intl.RelativeTimeFormat(langCode, { numeric: 'always' });
  const [unit, size] = RELATIVE_UNITS.find(([, seconds]) => diff >= seconds) || ['second', 1];

  return formatter.format(-Math.floor(diff / size), unit);
}

/** Возвращает undefined, если время неизвестно — подставлять нечего, «выдумывать» нельзя. */
export function formatSessionTime(
  unixSeconds: number | undefined, langCode = 'ru', nowMs = Date.now(), timeZone?: string,
): FormattedSessionTime | undefined {
  if (!isValidSessionDate(unixSeconds)) return undefined;

  return {
    text: formatSessionDateTime(unixSeconds, langCode, timeZone),
    ago: formatSessionAgo(unixSeconds, langCode, nowMs),
  };
}

export function getSessionTimes(session: SessionTimeSource, langCode = 'ru', nowMs = Date.now()) {
  return {
    login: formatSessionTime(session.dateCreated, langCode, nowMs),
    active: formatSessionTime(session.dateActive, langCode, nowMs),
  };
}
