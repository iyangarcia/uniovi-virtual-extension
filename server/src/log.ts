import { closeSync, existsSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

// Rotating log file for `--service` (no console there: the helper runs hidden). Every console.*
// call goes to <dir>/helper.log; when it passes maxBytes it becomes helper.1.log (older ones shift
// up to helper.<keep>.log, the oldest is dropped). Writes are synchronous, so a crash still leaves
// its last lines on disk.

export interface FileLogOptions {
  maxBytes?: number;
  /** Rotated files kept besides helper.log. */
  keep?: number;
  /** Also write to the original stderr (dev runs in a terminal). */
  mirror?: boolean;
}

export interface FileLog {
  file: string;
  write(line: string): void;
  close(): void;
}

export function openFileLog(dir: string, opts: FileLogOptions = {}): FileLog {
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const keep = opts.keep ?? 3;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "helper.log");
  const rotated = (n: number) => join(dir, `helper.${n}.log`);

  let fd = openSync(file, "a");
  let size = fstatSync(fd).size;

  const rotate = () => {
    closeSync(fd);
    rmSync(rotated(keep), { force: true });
    for (let n = keep - 1; n >= 1; n--) if (existsSync(rotated(n))) renameSync(rotated(n), rotated(n + 1));
    if (keep >= 1) renameSync(file, rotated(1));
    else rmSync(file, { force: true });
    fd = openSync(file, "a");
    size = 0;
  };

  const write = (line: string) => {
    const buf = Buffer.from(`${new Date().toISOString()} ${line}\n`, "utf8");
    try {
      if (size > 0 && size + buf.length > maxBytes) rotate();
      writeSync(fd, buf);
      size += buf.length;
    } catch {
      // Logging must never take the helper down (disk full, file locked by an editor...).
    }
  };

  return {
    file,
    write,
    close: () => {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    },
  };
}

/** Sends console.log/info/warn/error (and uncaught errors) to a rotating file. */
export function redirectConsole(log: FileLog, mirror = false): void {
  const original = console.error.bind(console);
  const sink =
    (level: string) =>
    (...args: unknown[]) => {
      const text = format(...args);
      log.write(level ? `${level} ${text}` : text);
      if (mirror) original(text);
    };
  console.log = sink("");
  console.info = sink("");
  console.warn = sink("WARN");
  console.error = sink("");
  process.on("uncaughtException", (err) => {
    log.write(`FATAL ${err.stack ?? String(err)}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    log.write(`unhandled rejection: ${(err as Error)?.stack ?? String(err)}`);
  });
}
