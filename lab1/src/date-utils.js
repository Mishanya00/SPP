const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

export function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function addDays(value, amount) {
  const date = new Date(value);
  date.setDate(date.getDate() + amount);
  return date;
}

export function toISODate(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseISODate(value) {
  const match = DATE_PATTERN.exec(String(value));
  if (!match) return null;

  const [, rawYear, rawMonth, rawDay] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

export function timeToMinutes(value) {
  const match = TIME_PATTERN.exec(String(value));
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function minutesToTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function formatDuration(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (!hours) return `${minutes} мин`;
  if (!minutes) return `${hours} ч`;
  return `${hours} ч ${minutes} мин`;
}

export function formatDateRange(first, last) {
  const sameMonth = first.getMonth() === last.getMonth();
  const sameYear = first.getFullYear() === last.getFullYear();
  const firstOptions = sameMonth
    ? { day: "numeric" }
    : { day: "numeric", month: "short" };
  const lastOptions = sameYear
    ? { day: "numeric", month: "long", year: "numeric" }
    : { day: "numeric", month: "long", year: "numeric" };

  return `${new Intl.DateTimeFormat("ru-RU", firstOptions).format(first)} — ${new Intl.DateTimeFormat("ru-RU", lastOptions).format(last)}`;
}

export function nextSuggestedSlot(now) {
  const current = new Date(now);
  const currentMinutes = current.getHours() * 60 + current.getMinutes();
  const rounded = Math.ceil(currentMinutes / 30) * 30;

  if (rounded <= 22 * 60) {
    return { date: toISODate(current), startTime: minutesToTime(rounded) };
  }

  return { date: toISODate(addDays(current, 1)), startTime: "09:00" };
}
