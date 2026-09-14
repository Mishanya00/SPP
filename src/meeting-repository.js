import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export class FileMeetingRepository {
  #queue = Promise.resolve();

  constructor(filePath) {
    this.filePath = filePath;
  }

  async list() {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const meetings = JSON.parse(contents);
      return Array.isArray(meetings) ? meetings : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async find(id) {
    return (await this.list()).find((meeting) => meeting.id === id) ?? null;
  }

  create(values) {
    return this.#mutate((meetings) => {
      const meeting = {
        id: randomUUID(),
        ...values,
        createdAt: new Date().toISOString(),
      };
      meetings.push(meeting);
      return meeting;
    });
  }

  update(id, values) {
    return this.#mutate((meetings) => {
      const index = meetings.findIndex((meeting) => meeting.id === id);
      if (index === -1) return null;
      meetings[index] = { ...meetings[index], ...values, updatedAt: new Date().toISOString() };
      return meetings[index];
    });
  }

  remove(id) {
    return this.#mutate((meetings) => {
      const index = meetings.findIndex((meeting) => meeting.id === id);
      if (index === -1) return false;
      meetings.splice(index, 1);
      return true;
    });
  }

  #mutate(operation) {
    const task = this.#queue.then(async () => {
      const meetings = await this.list();
      const result = operation(meetings);
      const temporaryPath = join(dirname(this.filePath), `.meetings-${process.pid}.tmp`);
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(meetings, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
      return result;
    });
    this.#queue = task.catch(() => undefined);
    return task;
  }
}

export class MemoryMeetingRepository {
  constructor(meetings = []) {
    this.meetings = structuredClone(meetings);
  }

  async list() {
    return structuredClone(this.meetings);
  }

  async find(id) {
    return structuredClone(this.meetings.find((meeting) => meeting.id === id) ?? null);
  }

  async create(values) {
    const meeting = { id: randomUUID(), ...values, createdAt: new Date().toISOString() };
    this.meetings.push(meeting);
    return structuredClone(meeting);
  }

  async update(id, values) {
    const index = this.meetings.findIndex((meeting) => meeting.id === id);
    if (index === -1) return null;
    this.meetings[index] = { ...this.meetings[index], ...values };
    return structuredClone(this.meetings[index]);
  }

  async remove(id) {
    const index = this.meetings.findIndex((meeting) => meeting.id === id);
    if (index === -1) return false;
    this.meetings.splice(index, 1);
    return true;
  }
}
