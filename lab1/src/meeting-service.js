import { parseISODate, timeToMinutes } from "./date-utils.js";

export const MEETING_COLORS = ["violet", "blue", "green", "orange", "rose"];

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function validateMeeting(input, { minDate, maxDate } = {}) {
  const values = {
    title: cleanText(input.title),
    date: cleanText(input.date),
    startTime: cleanText(input.startTime),
    duration: Number(input.duration),
    description: cleanText(input.description),
    color: MEETING_COLORS.includes(input.color) ? input.color : "violet",
  };
  const errors = {};
  const startMinutes = timeToMinutes(values.startTime);

  if (!values.title) errors.title = "Введите название встречи";
  else if (values.title.length > 80) errors.title = "Не больше 80 символов";

  if (!parseISODate(values.date)) {
    errors.date = "Выберите корректную дату";
  } else if (minDate && values.date < minDate) {
    errors.date = "Нельзя планировать встречу в прошлом";
  } else if (maxDate && values.date > maxDate) {
    errors.date = "Можно планировать не больше чем на год вперёд";
  }

  if (startMinutes === null) errors.startTime = "Выберите время начала";

  if (!Number.isInteger(values.duration) || values.duration < 15 || values.duration > 480) {
    errors.duration = "Продолжительность — от 15 минут до 8 часов";
  } else if (startMinutes !== null && startMinutes + values.duration > 24 * 60) {
    errors.duration = "Встреча должна закончиться до полуночи";
  }

  if (values.description.length > 240) {
    errors.description = "Не больше 240 символов";
  }

  return {
    values,
    errors,
    isValid: Object.keys(errors).length === 0,
  };
}

export function arrangeOverlaps(meetings) {
  const sorted = meetings
    .map((meeting) => ({
      ...meeting,
      startMinutes: timeToMinutes(meeting.startTime) ?? 0,
    }))
    .map((meeting) => ({
      ...meeting,
      endMinutes: meeting.startMinutes + Number(meeting.duration),
    }))
    .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);

  const clusters = [];
  let cluster = [];
  let clusterEnd = -1;

  for (const meeting of sorted) {
    if (cluster.length && meeting.startMinutes >= clusterEnd) {
      clusters.push(cluster);
      cluster = [];
      clusterEnd = -1;
    }
    cluster.push(meeting);
    clusterEnd = Math.max(clusterEnd, meeting.endMinutes);
  }
  if (cluster.length) clusters.push(cluster);

  return clusters.flatMap((items) => {
    const laneEnds = [];
    const positioned = items.map((meeting) => {
      let lane = laneEnds.findIndex((end) => end <= meeting.startMinutes);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = meeting.endMinutes;
      return { ...meeting, lane };
    });
    const laneCount = Math.max(laneEnds.length, 1);
    return positioned.map((meeting) => ({ ...meeting, laneCount }));
  });
}
