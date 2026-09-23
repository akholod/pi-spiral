// Regression verification owned by the loop: shell commands from
// `ralph.verify` (or the PRD's list) and the git delta of the working tree.
// Running these in code keeps the reviewer read-only while still giving it
// fresh evidence.

import { execFile, type ExecFileException } from 'node:child_process';

export interface CommandResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  // tail of combined stdout + stderr
  output: string;
}

const OUTPUT_TAIL = 6000;
const MAX_BUFFER = 16 * 1024 * 1024;

const tail = (text: string): string =>
  text.length > OUTPUT_TAIL
    ? `[... ${text.length - OUTPUT_TAIL} chars omitted]\n` +
      text.slice(-OUTPUT_TAIL)
    : text;

export const runCommand = (
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandResult> =>
  new Promise((resolve) => {
    execFile(
      'sh',
      ['-c', command],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        signal,
        encoding: 'utf8',
      },
      (error: ExecFileException | null, stdout, stderr) => {
        const output = tail(`${stdout}${stderr}`.trim());
        if (!error) {
          resolve({ command, ok: true, exitCode: 0, output });
          return;
        }
        const exitCode = typeof error.code === 'number' ? error.code : null;
        const reason = error.killed
          ? `\n[killed: timeout ${timeoutMs}ms or cancelled]`
          : exitCode === null
            ? `\n[${error.message}]`
            : '';
        resolve({ command, ok: false, exitCode, output: output + reason });
      },
    );
  });

// Sequential; every command runs so the report is complete.
export const runCommands = async (
  commands: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandResult[]> => {
  const results: CommandResult[] = [];
  for (const command of commands) {
    if (signal?.aborted) break;
    results.push(await runCommand(command, cwd, timeoutMs, signal));
  }
  return results;
};

export const allOk = (results: CommandResult[]): boolean =>
  results.every((r) => r.ok);

export const formatCommandResults = (results: CommandResult[]): string => {
  if (results.length === 0) return '(no verify commands configured)';
  return results
    .map(
      (r) =>
        `$ ${r.command}\n[${r.ok ? 'OK' : `FAILED exit ${r.exitCode ?? '?'}`}]\n${r.output}`,
    )
    .join('\n\n');
};

// Paths reported by `git status --porcelain` (modified, added, deleted,
// untracked), or null outside a git work tree.
export const gitDirtyFiles = (cwd: string): Promise<string[] | null> =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd, timeout: 15_000, maxBuffer: MAX_BUFFER },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const files = stdout
          .split('\n')
          .filter((line) => line.length > 3)
          .map((line) => {
            const path = line.slice(3);
            const arrow = path.indexOf(' -> ');
            return arrow >= 0 ? path.slice(arrow + 4) : path;
          });
        resolve(files);
      },
    );
  });
