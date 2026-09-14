document.querySelectorAll("[data-duration]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.querySelector('input[name="duration"]');
    if (input) input.value = button.dataset.duration;
  });
});

document.querySelectorAll("[data-delete-form]").forEach((form) => {
  form.addEventListener("submit", (event) => {
    if (!window.confirm("Удалить эту встречу?")) event.preventDefault();
  });
});

document.querySelectorAll(".notice__close").forEach((button) => {
  button.addEventListener("click", () => button.closest(".notice")?.remove());
});

const calendarScroll = document.querySelector(".calendar-scroll");
const editedMeeting = document.querySelector(".meeting.is-editing");
const nowLine = document.querySelector(".now-line");
const calendarTarget = editedMeeting ?? nowLine;
if (calendarScroll && calendarTarget) {
  requestAnimationFrame(() => {
    calendarScroll.scrollTop = Math.max(calendarTarget.offsetTop - 180, 0);
  });
}
