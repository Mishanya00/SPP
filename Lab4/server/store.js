import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { newWorld, migrateWorld } from './game.js';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, 'galaxy.json');
    try {
      this.state = JSON.parse(readFileSync(this.file, 'utf8'));
      if (![1, 2].includes(this.state.version) || !this.state.users || !Array.isArray(this.state.contracts)) throw new Error('Unsupported save format');
      if (this.state.version === 1) { migrateWorld(this.state); this.persist(this.state); }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error; // Never silently overwrite a damaged save.
      this.state = newWorld();
      this.persist(this.state);
    }
  }
  persist(state) {
    const fd = openSync(`${this.file}.tmp`, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(`${this.file}.tmp`, this.file);
  }
  transact(callback) {
    const next = structuredClone(this.state);
    const result = callback(next);
    next.revision++;
    this.persist(next); // Publish only after durable write; failed actions never partially mutate state.
    this.state = next;
    return result;
  }
}
