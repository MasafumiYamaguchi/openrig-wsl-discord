import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'state.json');
    this.lockFile = path.join(directory, 'bridge.lock');
    this.data = { version: 1, jobs: {}, replies: {} };
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (this.data.version !== 1 || !this.data.jobs || !this.data.replies) throw new Error('状態ファイルの形式が不正です。');
    }
  }

  lock() {
    try {
      this.lockFd = fs.openSync(this.lockFile, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(this.lockFile, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('ロックファイルを確認してください。');
      try { process.kill(pid, 0); }
      catch (probeError) {
        if (probeError.code !== 'ESRCH') throw probeError;
        fs.unlinkSync(this.lockFile);
        this.lockFd = fs.openSync(this.lockFile, 'wx', 0o600);
      }
      if (this.lockFd === undefined) throw new Error('Botは既に起動しています。');
    }
    fs.writeFileSync(this.lockFd, String(process.pid));
  }

  unlock() {
    if (this.lockFd === undefined) return;
    fs.closeSync(this.lockFd);
    if (fs.readFileSync(this.lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(this.lockFile);
    this.lockFd = undefined;
  }

  save() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.data, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
  }

  job(id) { return this.data.jobs[id]; }
  put(job) { this.data.jobs[job.id] = job; this.save(); return job; }
  jobs() { return Object.values(this.data.jobs); }
  byThread(threadId) { return this.jobs().find(job => job.threadId === threadId); }
}
