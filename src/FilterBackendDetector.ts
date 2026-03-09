import { spawn } from 'child_process';
import type { FilterBackend } from './Types';

export class FilterBackendDetector {
  private cached?: Promise<FilterBackend>;

  getFilterBackend(): Promise<FilterBackend> {
    if (!this.cached) {
      this.cached = this.detect();
    }
    return this.cached;
  }

  private async detect(): Promise<FilterBackend> {
    if (await this.isCommandAvailable('rg', ['--version'])) {
      return 'rg';
    }
    if (await this.isCommandAvailable('grep', ['--version'])) {
      return 'grep';
    }
    return 'js';
  }

  private isCommandAvailable(command: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, { stdio: 'ignore' });
      proc.on('error', () => resolve(false));
      proc.on('close', () => resolve(true));
    });
  }
}
