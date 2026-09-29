import fs from "node:fs";
import path from "node:path";

// Small JSON file for settings and runtime state, written atomically.
export class JsonStore<T extends object> {
  private data: T;

  constructor(private file: string, defaults: T, private mode = 0o644) {
    this.data = { ...defaults };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      // first run
    }
  }

  get<K extends keyof T>(key: K): T[K] {
    return this.data[key];
  }

  snapshot(): T {
    return structuredClone(this.data);
  }

  update(values: Partial<T>) {
    Object.assign(this.data, values);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: this.mode });
    fs.renameSync(tmp, this.file);
  }
}
