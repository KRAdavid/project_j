import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { rmSync as removeSync } from 'node:fs';
import { dirname } from 'node:path';

export class OperationLockError extends Error {
  constructor(message, code = 'OPERATION_LOCK_FAILED') {
    super(message);
    this.code = code;
  }
}

const isProcessAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const readLock = async (lockPath) => {
  try { return JSON.parse(await readFile(lockPath, 'utf8')); } catch { return null; }
};

export const acquireOperationLock = async (lockPath, { staleAfterMs = 15 * 60 * 1000 } = {}) => {
  if (!lockPath) throw new OperationLockError('운영 잠금 경로가 필요합니다.', 'OPERATION_LOCK_PATH_REQUIRED');
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8');
      await handle.close();
      let released = false;
      const releaseSync = () => {
        if (released) return;
        released = true;
        try { removeSync(lockPath, { force: true }); } catch {}
      };
      const release = async () => {
        if (released) return;
        released = true;
        await rm(lockPath, { force: true });
      };
      return { lockPath, release, releaseSync };
    } catch (error) {
      if (error.code !== 'EEXIST') throw new OperationLockError(`운영 잠금을 만들 수 없습니다: ${error.message}`);
      const existing = await readLock(lockPath);
      const createdAt = existing?.createdAt ? Date.parse(existing.createdAt) : NaN;
      const fresh = Number.isFinite(createdAt) && Date.now() - createdAt < staleAfterMs;
      const ownerPid = Number(existing?.pid);
      const ownerAlive = isProcessAlive(ownerPid);
      if (fresh && ownerAlive) {
        throw new OperationLockError('다른 운영 사이클이 이미 실행 중입니다.', 'OPERATION_ALREADY_RUNNING');
      }
      // A process can be terminated after creating the lock (for example,
      // during a host restart or a Windows process-tree kill). If the recorded
      // owner is definitely gone, recover immediately instead of waiting for
      // the stale-age window. Unknown or malformed owners still fail closed.
      if (existing?.pid && !ownerAlive) {
        await rm(lockPath, { force: true });
        continue;
      }
      try {
        const fileStat = await stat(lockPath);
        if (Date.now() - fileStat.mtimeMs < staleAfterMs) throw new OperationLockError('운영 잠금 상태를 확인할 수 없습니다.', 'OPERATION_LOCK_UNCERTAIN');
      } catch (statError) {
        if (statError instanceof OperationLockError) throw statError;
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new OperationLockError('운영 잠금을 확보하지 못했습니다.');
};

