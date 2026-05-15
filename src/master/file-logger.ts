/**
 * Rotating file logger that implements the PluginLogger interface.
 *
 * Writes log lines to disk with automatic rotation:
 *   - maxFileSizeBytes  (default 5 MB)  — rotate when current file exceeds this
 *   - maxFiles          (default 10)    — keep at most this many rotated files
 *
 * File naming: pimclaw.log (current), pimclaw.log.1, …, pimclaw.log.9
 *
 * An optional upstream PluginLogger can be provided so every log line is
 * forwarded to the host runtime (e.g. OpenClaw's built-in logger) in addition
 * to being written to the file.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';

export interface FileLoggerConfig {
  logDir: string;
  maxFileSizeBytes: number;
  maxFiles: number;
  logFileName: string;
}

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_FILES = 10;
const DEFAULT_LOG_FILE_NAME = 'pimclaw.log';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export class FileLogger implements PluginLogger {
  private readonly config: FileLoggerConfig;
  private readonly upstream: PluginLogger | null;
  private stream: fs.WriteStream | null = null;
  private currentSize: number = 0;
  private rotating: boolean = false;

  constructor(
    config: Pick<FileLoggerConfig, 'logDir'> & Partial<Omit<FileLoggerConfig, 'logDir'>>,
    upstream?: PluginLogger,
  ) {
    this.config = {
      logDir: config.logDir,
      maxFileSizeBytes: config.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE,
      maxFiles: config.maxFiles ?? DEFAULT_MAX_FILES,
      logFileName: config.logFileName ?? DEFAULT_LOG_FILE_NAME,
    };
    this.upstream = upstream ?? null;
  }

  /**
   * Create the log directory (if needed) and open the write stream.
   * Must be called before the first log line.
   */
  async initialize(): Promise<void> {
    await fsp.mkdir(this.config.logDir, { recursive: true });

    const logPath = this.logFilePath();
    try {
      const stat = await fsp.stat(logPath);
      this.currentSize = stat.size;
    } catch {
      this.currentSize = 0;
    }

    this.openStream();
  }

  // ── PluginLogger interface ───────────────────────────────────────────────

  debug(message: string, ...args: unknown[]): void {
    this.upstream?.debug(message, ...args);
    this.write('DEBUG', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.upstream?.info(message, ...args);
    this.write('INFO', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.upstream?.warn(message, ...args);
    this.write('WARN', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.upstream?.error(message, ...args);
    this.write('ERROR', message, args);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Flush pending writes and close the underlying stream.
   */
  async close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stream) {
        this.stream.end(() => {
          this.stream = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private logFilePath(index?: number): string {
    const base = path.join(this.config.logDir, this.config.logFileName);
    return index != null && index > 0 ? `${base}.${index}` : base;
  }

  private openStream(): void {
    this.stream = fs.createWriteStream(this.logFilePath(), { flags: 'a' });
    this.stream.on('error', (err) => {
      process.stderr.write(`[FileLogger] stream error: ${err.message}\n`);
    });
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (!this.stream || this.rotating) return;

    const timestamp = new Date().toISOString();
    let line = `${timestamp} [${level}] ${message}`;

    if (args.length > 0) {
      const extra = args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      if (extra.length > 0) {
        line += ` ${extra}`;
      }
    }

    line += '\n';

    const bytes = Buffer.byteLength(line, 'utf-8');
    this.stream.write(line);
    this.currentSize += bytes;

    if (this.currentSize >= this.config.maxFileSizeBytes) {
      this.rotate();
    }
  }

  /**
   * Rotate log files synchronously.
   *
   * Rotation order (10 files max, 0-indexed as .1 … .9):
   *   1. Delete the oldest file (.9) if it exists
   *   2. Shift each file up by one:  .8 → .9, .7 → .8, …, .1 → .2
   *   3. Rename the current file → .1
   *   4. Open a fresh stream for the new current file
   */
  private rotate(): void {
    this.rotating = true;
    try {
      // Close the current stream immediately
      if (this.stream) {
        this.stream.destroy();
        this.stream = null;
      }

      // Delete the oldest rotated file
      const oldest = this.logFilePath(this.config.maxFiles - 1);
      try { fs.unlinkSync(oldest); } catch { /* file may not exist */ }

      // Shift rotated files: N-2 → N-1, …, 1 → 2
      for (let i = this.config.maxFiles - 2; i >= 1; i--) {
        const from = this.logFilePath(i);
        const to = this.logFilePath(i + 1);
        try { fs.renameSync(from, to); } catch { /* file may not exist */ }
      }

      // Current → .1
      try {
        fs.renameSync(this.logFilePath(), this.logFilePath(1));
      } catch { /* current may not exist */ }

      // Open a fresh stream
      this.currentSize = 0;
      this.openStream();
    } finally {
      this.rotating = false;
    }
  }
}
