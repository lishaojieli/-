import { readFile, rename, mkdir, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export class RoomStore {
  constructor(directory) { this.directory = directory; this.pending = Promise.resolve(); }
  async load() {
    await mkdir(this.directory, { recursive: true });
    if (!this.lock) {
      const lockPath = path.join(this.directory, 'scheduler.lock');
      try { this.lock = await open(lockPath, 'wx'); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        let alive = true; try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (alive) throw new Error('该数据目录已有调度服务，禁止并发打开。');
        await unlink(lockPath); this.lock = await open(lockPath, 'wx');
      }
      this.lockToken = randomUUID(); await this.lock.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken })); await this.lock.sync();
    }
    try { const value = JSON.parse(await readFile(path.join(this.directory, 'room.json'), 'utf8')); if (![1, 2, 3].includes(value.version) || !Array.isArray(value.messages) || !Array.isArray(value.tasks) || (value.version >= 2 && !Array.isArray(value.chats))) throw new Error('Invalid room'); return value; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { version: 1, messages: [], tasks: [], currentTaskId: null }; }
  }
  save(state) {
    const serialized = JSON.stringify(state, null, 2);
    const filename = path.join(this.directory, 'room.json');
    const operation = this.pending.then(async () => {
      const file = await open(filename + '.tmp', 'w');
      try { await file.writeFile(serialized, 'utf8'); await file.sync(); } finally { await file.close(); }
      for (let attempt = 0; ; attempt++) {
        try { await rename(filename + '.tmp', filename); break; }
        catch (error) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 6) throw error; await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1))); }
      }
    });
    this.pending = operation.catch(() => {}); return operation;
  }
  async close() { await this.pending; if (this.lock) { await this.lock.close(); this.lock = null; const filename = path.join(this.directory, 'scheduler.lock'); const owner = JSON.parse(await readFile(filename, 'utf8')); if (owner.token === this.lockToken) await unlink(filename); } }
}
