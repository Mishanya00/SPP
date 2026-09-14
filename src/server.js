import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { FileMeetingRepository } from "./meeting-repository.js";

process.env.TZ ||= "Europe/Minsk";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repository = new FileMeetingRepository(join(currentDirectory, "..", "data", "meetings.json"));
const app = createApp({ repository });
const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`Календарь доступен по адресу http://localhost:${port}`);
});
