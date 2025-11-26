/**
 * Logger for Conformance Test Runner
 *
 * Writes output to both console and file
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface OutputContext {
  outputDir: string;
  runLogPath: string;
  debugLogPath: string;
  screenshotDir: string;
  planName: string;
  timestamp: string;
}

export class Logger {
  private runLogStream: fs.WriteStream | null = null;
  private debugLogStream: fs.WriteStream | null = null;
  private context: OutputContext | null = null;
  private verbose: boolean = false;

  /**
   * Initialize logger with output directory
   *
   * Directory structure: baseDir/displayName/results/timestamp/
   * Example: ./conformance/OIDC Basic OP/results/2025-11-26_0043/
   */
  async initialize(displayName: string, baseDir: string, verbose: boolean = false): Promise<OutputContext> {
    this.verbose = verbose;

    // Create timestamp: YYYY-MM-DD_HHmm
    const now = new Date();
    const timestamp = now.toISOString()
      .replace(/[:.]/g, '')
      .replace('T', '_')
      .slice(0, 15);

    // New directory structure: baseDir/displayName/results/timestamp
    const outputDir = path.join(baseDir, displayName, 'results', timestamp);
    const screenshotDir = path.join(outputDir, 'screenshots');

    // Create directories
    await fs.promises.mkdir(outputDir, { recursive: true });
    await fs.promises.mkdir(screenshotDir, { recursive: true });

    const runLogPath = path.join(outputDir, 'run.log');
    const debugLogPath = path.join(outputDir, 'debug.log');

    // Create write streams
    this.runLogStream = fs.createWriteStream(runLogPath, { flags: 'a' });
    this.debugLogStream = fs.createWriteStream(debugLogPath, { flags: 'a' });

    this.context = {
      outputDir,
      runLogPath,
      debugLogPath,
      screenshotDir,
      planName: displayName,
      timestamp,
    };

    // Write header to logs
    const header = `# Conformance Test Run: ${displayName}\n# Started: ${now.toISOString()}\n${'='.repeat(60)}\n\n`;
    this.runLogStream.write(header);
    this.debugLogStream.write(header);

    return this.context;
  }

  /**
   * Get current output context
   */
  getContext(): OutputContext | null {
    return this.context;
  }

  /**
   * Log to console and run.log
   */
  log(...args: unknown[]): void {
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');
    console.log(...args);
    if (this.runLogStream) {
      this.runLogStream.write(message + '\n');
    }
  }

  /**
   * Log error to console and run.log
   */
  error(...args: unknown[]): void {
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');
    console.error(...args);
    if (this.runLogStream) {
      this.runLogStream.write('[ERROR] ' + message + '\n');
    }
  }

  /**
   * Log debug info (only to debug.log, and to console if verbose)
   */
  debug(...args: unknown[]): void {
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');
    if (this.verbose) {
      console.log('[DEBUG]', ...args);
    }
    if (this.debugLogStream) {
      this.debugLogStream.write('[DEBUG] ' + message + '\n');
    }
  }

  /**
   * Log verbose info (to both if verbose mode)
   */
  verbose_log(...args: unknown[]): void {
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');
    if (this.verbose) {
      console.log(...args);
      if (this.runLogStream) {
        this.runLogStream.write(message + '\n');
      }
    }
    if (this.debugLogStream) {
      this.debugLogStream.write(message + '\n');
    }
  }

  /**
   * Close log streams
   */
  async close(): Promise<void> {
    if (this.context) {
      const footer = `\n${'='.repeat(60)}\n# Finished: ${new Date().toISOString()}\n`;
      if (this.runLogStream) {
        this.runLogStream.write(footer);
        this.runLogStream.end();
      }
      if (this.debugLogStream) {
        this.debugLogStream.write(footer);
        this.debugLogStream.end();
      }
    }

    // Wait for streams to finish
    await Promise.all([
      this.runLogStream ? new Promise<void>(resolve => this.runLogStream!.on('finish', () => resolve())) : Promise.resolve(),
      this.debugLogStream ? new Promise<void>(resolve => this.debugLogStream!.on('finish', () => resolve())) : Promise.resolve(),
    ]);

    this.runLogStream = null;
    this.debugLogStream = null;
    this.context = null;
  }
}

/**
 * Create a default logger (console only, no file output)
 */
export function createConsoleLogger(): Logger {
  return new Logger();
}
