import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../../scripts/restart-codex-desktop.ps1', import.meta.url));
const powershellArguments = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const JOB_TIMEOUT_MS = 90_000;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATES = new Set(['pending', 'restarting', 'completed', 'failed', 'unknown']);
const ERRORS = new Set([
  'desktop_restart_target_unavailable', 'desktop_restart_identity_changed',
  'desktop_restart_stop_failed', 'desktop_restart_stop_timeout',
  'desktop_restart_activation_failed', 'desktop_restart_activation_timeout',
  'desktop_restart_helper_failed', 'desktop_restart_status_unavailable', 'desktop_restart_status_timeout',
  'desktop_restart_state_write_failed',
]);

export type DesktopRestartStatus = {
  id: string;
  status: 'pending' | 'restarting' | 'completed' | 'failed' | 'unknown';
  error?: string;
  startedAt?: number;
  finishedAt?: number;
};

function readDocument(path: string, limit = 16_384): any {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > limit) throw new Error('invalid_restart_document');
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function writeDocument(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  try { renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

function markHelperFailure(resultPath: string, id: string) {
  try {
    const job = readDocument(resultPath);
    if (job.id === id && (job.status === 'pending' || job.status === 'restarting')) {
      writeDocument(resultPath, { id, status: 'failed', error: 'desktop_restart_helper_failed',
        startedAt: job.startedAt, finishedAt: Date.now() });
    }
  } catch { /* Polling exposes a missing or corrupt status as unknown. */ }
}

export interface DesktopRestartRunner {
  check(script: string): Promise<string>;
  launch(script: string, resultPath: string, operationId: string): Promise<void>;
}

export const powerShellRestartRunner: DesktopRestartRunner = {
  async check(script) {
    const { stdout } = await execFileAsync('powershell.exe', [
      ...powershellArguments, '-File', script, '-CheckOnly',
    ], { windowsHide: true, timeout: 15_000, maxBuffer: 4096, encoding: 'utf8' });
    return stdout;
  },
  async launch(script, resultPath, operationId) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', [...powershellArguments, '-File', script,
        '-OperationId', operationId, '-ResultPath', resultPath], {
        // Windows PowerShell can exit before executing its body with DETACHED_PROCESS.
        // The connector is independent of Desktop; unref is sufficient here.
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('exit', () => { markHelperFailure(resultPath, operationId); });
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  },
};

/** Restarts the current user's packaged Desktop app only after an explicit caller confirmation. */
export class DesktopRestarter {
  private readonly platform: NodeJS.Platform;
  private readonly runner: DesktopRestartRunner;
  private readonly stateDirectory: string;
  private readonly now: () => number;
  private starting: Promise<DesktopRestartStatus> | null = null;

  constructor(options: { platform?: NodeJS.Platform; runner?: DesktopRestartRunner;
    stateDirectory?: string; now?: () => number } = {}) {
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? powerShellRestartRunner;
    this.stateDirectory = resolve(options.stateDirectory || join(homedir(), '.codex-anywhere', 'desktop-restarts'));
    this.now = options.now || Date.now;
  }

  async isSupported(): Promise<boolean> {
    if (this.platform !== 'win32') return false;
    try {
      const result: unknown = JSON.parse(await this.runner.check(scriptPath));
      return typeof result === 'object' && result !== null
        && Object.keys(result).length === 1
        && 'supported' in result && result.supported === true;
    } catch {
      return false;
    }
  }

  /** Submits a tracked operation. Only a helper-verified process replacement is completed. */
  restart(): Promise<DesktopRestartStatus> {
    if (this.starting) return this.starting;
    this.starting = this.startRestart().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startRestart(): Promise<DesktopRestartStatus> {
    const existing = await this.status();
    if (existing?.status === 'pending' || existing?.status === 'restarting') return existing;
    if (!await this.isSupported()) throw new Error('desktop_restart_unavailable');
    const id = randomUUID();
    const job: DesktopRestartStatus = { id, status: 'pending', startedAt: this.now() };
    const resultPath = join(this.stateDirectory, `${id}.json`);
    try {
      mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 });
      writeDocument(resultPath, job);
      writeDocument(join(this.stateDirectory, 'latest.json'), { id });
    } catch { throw new Error('desktop_restart_status_unavailable'); }
    try {
      await this.runner.launch(scriptPath, resultPath, id);
    } catch {
      markHelperFailure(resultPath, id);
      throw new Error('desktop_restart_failed');
    }
    return (await this.status(id))!;
  }

  async status(operationId?: string): Promise<DesktopRestartStatus | null> {
    let id = operationId;
    if (id === undefined) {
      try { id = readDocument(join(this.stateDirectory, 'latest.json'), 1024)?.id; }
      catch { return null; }
    }
    if (typeof id !== 'string' || !JOB_ID.test(id)) {
      if (operationId === undefined) return null;
      throw new Error('desktop_restart_invalid_id');
    }
    const unknown = (): DesktopRestartStatus => ({ id: id!, status: 'unknown', error: 'desktop_restart_status_unavailable' });
    try {
      const document = readDocument(join(this.stateDirectory, `${id}.json`));
      if (document.id !== id || !STATES.has(document.status)
        || typeof document.startedAt !== 'number' || !Number.isFinite(document.startedAt)
        || document.startedAt < 0 || document.startedAt > this.now() + 60_000) return unknown();
      if ((document.status === 'pending' || document.status === 'restarting')
        && this.now() - document.startedAt > JOB_TIMEOUT_MS) {
        return { id, status: 'unknown', error: 'desktop_restart_status_timeout', startedAt: document.startedAt };
      }
      if (document.status === 'completed' && (typeof document.finishedAt !== 'number'
        || !Number.isFinite(document.finishedAt) || document.finishedAt < document.startedAt)) return unknown();
      return { id, status: document.status, startedAt: document.startedAt,
        ...(typeof document.finishedAt === 'number' && Number.isFinite(document.finishedAt) ? { finishedAt: document.finishedAt } : {}),
        ...(document.status === 'failed' || document.status === 'unknown'
          ? { error: ERRORS.has(document.error) ? document.error : 'desktop_restart_helper_failed' } : {}) };
    } catch { return unknown(); }
  }
}
