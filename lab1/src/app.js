import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addDays,
  formatDateRange,
  formatDuration,
  minutesToTime,
  nextSuggestedSlot,
  startOfDay,
  toISODate,
} from "./date-utils.js";
import { arrangeOverlaps, MEETING_COLORS, validateMeeting } from "./meeting-service.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const rootDirectory = join(currentDirectory, "..");
const HOUR_HEIGHT = 56;
const HOURS = Array.from({ length: 24 }, (_, index) => ({
  label: `${String(index).padStart(2, "0")}:00`,
  top: index * HOUR_HEIGHT,
}));
const NOTICES = {
  created: "Встреча добавлена в календарь",
  updated: "Изменения сохранены",
  deleted: "Встреча удалена",
  missing: "Встреча уже удалена или не найдена",
};

function viewSize(value) {
  return String(value) === "7" ? 7 : 3;
}

function meetingWord(count) {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return "встреч";
  if (lastDigit === 1) return "встреча";
  if (lastDigit >= 2 && lastDigit <= 4) return "встречи";
  return "встреч";
}

function meetingEnd(meeting) {
  const [hours, minutes] = meeting.startTime.split(":").map(Number);
  return minutesToTime(hours * 60 + minutes + Number(meeting.duration));
}

function dayViewModels(today, count, meetings, now) {
  return Array.from({ length: count }, (_, index) => {
    const date = addDays(today, index);
    const isoDate = toISODate(date);
    const dayMeetings = arrangeOverlaps(meetings.filter((meeting) => meeting.date === isoDate))
      .map((meeting) => ({
        ...meeting,
        endTime: meetingEnd(meeting),
        top: (meeting.startMinutes * HOUR_HEIGHT) / 60,
        height: Math.max((Number(meeting.duration) * HOUR_HEIGHT) / 60 - 4, 35),
        left: (meeting.lane * 100) / meeting.laneCount,
        width: 100 / meeting.laneCount,
      }));
    const totalMinutes = dayMeetings.reduce((sum, meeting) => sum + Number(meeting.duration), 0);

    return {
      isoDate,
      dayNumber: date.getDate(),
      weekday: new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(date).replace(".", ""),
      month: new Intl.DateTimeFormat("ru-RU", { month: "short" }).format(date).replace(".", ""),
      isToday: index === 0,
      currentTop: index === 0
        ? ((now.getHours() * 60 + now.getMinutes()) * HOUR_HEIGHT) / 60
        : null,
      meetings: dayMeetings,
      totalMinutes,
    };
  });
}

function defaultForm(now) {
  const suggested = nextSuggestedSlot(now);
  return {
    title: "",
    date: suggested.date,
    startTime: suggested.startTime,
    duration: 60,
    description: "",
    color: "violet",
  };
}

export function createApp({ repository, clock = () => new Date() }) {
  if (!repository) throw new Error("Meeting repository is required");

  const app = express();
  app.set("view engine", "ejs");
  app.set("views", join(rootDirectory, "views"));
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  app.use(express.static(join(rootDirectory, "public"), { maxAge: 0 }));

  async function renderCalendar(req, res, options = {}) {
    const now = clock();
    const today = startOfDay(now);
    const count = viewSize(options.view ?? req.query.days ?? req.body?.view);
    const meetings = await repository.list();
    const days = dayViewModels(today, count, meetings, now);
    let form = options.form ?? null;

    if (!form && req.query.edit) form = await repository.find(req.query.edit);
    if (!form) form = defaultForm(now);

    const lastDay = addDays(today, count - 1);
    const visibleMeetings = days.flatMap((day) => day.meetings);

    return res.status(options.status ?? 200).render("calendar", {
      pageTitle: "Ближайшие встречи — Рядом",
      view: count,
      days,
      hours: HOURS,
      form,
      errors: options.errors ?? {},
      isEditing: Boolean(form.id),
      colors: MEETING_COLORS,
      todayISO: toISODate(today),
      maxDateISO: toISODate(addDays(today, 365)),
      dateRange: formatDateRange(today, lastDay),
      formatDuration,
      meetingWord,
      visibleCount: visibleMeetings.length,
      visibleDuration: formatDuration(
        visibleMeetings.reduce((sum, meeting) => sum + Number(meeting.duration), 0),
      ),
      notice: NOTICES[req.query.notice] ?? null,
    });
  }

  app.get("/", async (req, res, next) => {
    try {
      await renderCalendar(req, res);
    } catch (error) {
      next(error);
    }
  });

  app.post("/meetings", async (req, res, next) => {
    try {
      const today = startOfDay(clock());
      const result = validateMeeting(req.body, {
        minDate: toISODate(today),
        maxDate: toISODate(addDays(today, 365)),
      });
      if (!result.isValid) {
        return renderCalendar(req, res, {
          status: 422,
          form: result.values,
          errors: result.errors,
        });
      }

      await repository.create(result.values);
      return res.redirect(303, `/?days=${viewSize(req.body.view)}&notice=created`);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/meetings/:id/update", async (req, res, next) => {
    try {
      const today = startOfDay(clock());
      const result = validateMeeting(req.body, {
        minDate: toISODate(today),
        maxDate: toISODate(addDays(today, 365)),
      });
      if (!result.isValid) {
        return renderCalendar(req, res, {
          status: 422,
          form: { ...result.values, id: req.params.id },
          errors: result.errors,
        });
      }

      const meeting = await repository.update(req.params.id, result.values);
      const notice = meeting ? "updated" : "missing";
      return res.redirect(303, `/?days=${viewSize(req.body.view)}&notice=${notice}`);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/meetings/:id/delete", async (req, res, next) => {
    try {
      const removed = await repository.remove(req.params.id);
      const notice = removed ? "deleted" : "missing";
      return res.redirect(303, `/?days=${viewSize(req.body.view)}&notice=${notice}`);
    } catch (error) {
      return next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).render("404", { pageTitle: "Страница не найдена — Рядом" });
  });

  app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) return next(error);
    return res.status(500).render("500", { pageTitle: "Ошибка сервера — Рядом" });
  });

  return app;
}
