import * as vscode from 'vscode';
import * as fs from 'fs';
import { spawn } from 'child_process';
import type {
  FilterBackend,
  FilteredModelStats,
  ProgressUpdate,
  LinePayload,
  CancelableTask
} from './Types';

export class IndexedFileModel {
  private readonly uri: vscode.Uri;
  private indexed = false;
  private lineStarts: number[] = [];
  private lineEnds: number[] = [];

  private filteredLineNumbers: number[] = [];
  private filteredStarts: number[] = [];
  private filteredEnds: number[] = [];

  private activeFilterTask: CancelableTask | null = null;
  private indexingPromise: Promise<void> | null = null;

  constructor(uri: vscode.Uri) {
    this.uri = uri;
  }

  get isIndexed(): boolean {
    return this.indexed;
  }

  cancelActiveFilter(): void {
    if (this.activeFilterTask) {
      this.activeFilterTask.cancel();
      this.activeFilterTask = null;
    }
  }

  async ensureIndexed(onProgress?: (update: ProgressUpdate) => void): Promise<void> {
    if (this.indexed) {
      return;
    }
    if (this.indexingPromise) {
      await this.indexingPromise;
      return;
    }
    this.indexingPromise = this.doIndex(onProgress);
    try {
      await this.indexingPromise;
    } finally {
      this.indexingPromise = null;
    }
  }

  private async doIndex(onProgress?: (update: ProgressUpdate) => void): Promise<void> {
    const stats = await fs.promises.stat(this.uri.fsPath);
    const fileSize = stats.size;

    const starts: number[] = [];
    const ends: number[] = [];

    if (fileSize === 0) {
      this.lineStarts = starts;
      this.lineEnds = ends;
      this.filteredLineNumbers = [];
      this.filteredStarts = [];
      this.filteredEnds = [];
      this.indexed = true;
      onProgress?.({ phase: 'indexing', processed: 0, total: 0, matched: 0, detail: 'Indexed 0 lines' });
      return;
    }

    onProgress?.({ phase: 'indexing', processed: 0, total: fileSize, matched: 0, detail: 'Building line index' });

    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(this.uri.fsPath);
      let lineStart = 0;
      let absoluteOffset = 0;
      let previousByte: number | null = null;
      let lastProgressAt = Date.now();

      stream.on('data', (chunk: Buffer | string) => {
        const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        for (let i = 0; i < data.length; i += 1) {
          const byte = data[i];
          if (byte === 0x0a) {
            let lineEnd = absoluteOffset + i;
            if (previousByte === 0x0d && lineEnd > lineStart) {
              lineEnd -= 1;
            }
            starts.push(lineStart);
            ends.push(lineEnd);
            lineStart = absoluteOffset + i + 1;
          }
          previousByte = byte;
        }
        absoluteOffset += data.length;
        const now = Date.now();
        if (now - lastProgressAt >= 250) {
          onProgress?.({
            phase: 'indexing',
            processed: absoluteOffset,
            total: fileSize,
            matched: starts.length,
            detail: 'Building line index'
          });
          lastProgressAt = now;
        }
      });

      stream.on('error', (error) => reject(error));
      stream.on('end', () => {
        if (lineStart < fileSize) {
          starts.push(lineStart);
          ends.push(fileSize);
        }
        resolve();
      });
    });

    this.lineStarts = starts;
    this.lineEnds = ends;
    this.filteredLineNumbers = [];
    this.filteredStarts = [];
    this.filteredEnds = [];
    this.indexed = true;
    onProgress?.({
      phase: 'indexing',
      processed: fileSize,
      total: fileSize,
      matched: this.lineStarts.length,
      detail: `Indexed ${this.lineStarts.length} lines`
    });
  }

  async buildFilteredModel(
    filterText: string,
    excludeText: string,
    caseSensitive: boolean,
    caseSensitiveExclude: boolean,
    backend: FilterBackend,
    onProgress?: (update: ProgressUpdate) => void
  ): Promise<FilteredModelStats> {
    await this.ensureIndexed(onProgress);
    this.cancelActiveFilter();

    const totalLines = this.lineStarts.length;
    const maxLineNumber = totalLines;
    const trimmedFilter = filterText.trim();
    const trimmedExclude = excludeText.trim();

    onProgress?.({
      phase: 'filtering',
      processed: 0,
      total: totalLines,
      matched: 0,
      detail: 'Preparing filter'
    });

    if (trimmedFilter.length === 0 && trimmedExclude.length === 0) {
      const allNumbers: number[] = new Array(totalLines);
      const allStarts: number[] = new Array(totalLines);
      const allEnds: number[] = new Array(totalLines);
      for (let i = 0; i < totalLines; i += 1) {
        allNumbers[i] = i + 1;
        allStarts[i] = this.lineStarts[i];
        allEnds[i] = this.lineEnds[i];
      }
      this.filteredLineNumbers = allNumbers;
      this.filteredStarts = allStarts;
      this.filteredEnds = allEnds;
      onProgress?.({
        phase: 'filtering',
        processed: totalLines,
        total: totalLines,
        matched: totalLines,
        detail: 'No filter applied'
      });
      return {
        totalLines,
        matchedLines: totalLines,
        maxLineNumber
      };
    }

    // --- Exclude pass ---
    let excludedLineNumbers: Set<number> | null = null;
    if (trimmedExclude.length > 0) {
      excludedLineNumbers = new Set<number>();
      const excludeSet = excludedLineNumbers;
      const markExcluded = (lineNumber: number) => { excludeSet.add(lineNumber); };
      if (backend === 'rg' || backend === 'grep') {
        await this.filterWithExternalTool(excludeText, backend, caseSensitiveExclude, markExcluded, totalLines, onProgress);
      } else {
        await this.filterWithJs(excludeText, caseSensitiveExclude, markExcluded, totalLines, onProgress);
      }
    }

    const starts: number[] = [];
    const ends: number[] = [];
    const lineNumbers: number[] = [];

    const appendLine = (lineNumber: number) => {
      if (excludedLineNumbers && excludedLineNumbers.has(lineNumber)) {
        return;
      }
      const idx = lineNumber - 1;
      if (idx < 0 || idx >= this.lineStarts.length) {
        return;
      }
      lineNumbers.push(lineNumber);
      starts.push(this.lineStarts[idx]);
      ends.push(this.lineEnds[idx]);
    };

    if (trimmedFilter.length === 0) {
      // No include filter: start from all lines, only exclude applies.
      for (let i = 1; i <= totalLines; i += 1) {
        appendLine(i);
      }
    } else {
      if (backend === 'rg' || backend === 'grep') {
        await this.filterWithExternalTool(filterText, backend, caseSensitive, appendLine, totalLines, onProgress);
      } else {
        await this.filterWithJs(filterText, caseSensitive, appendLine, totalLines, onProgress);
      }
    }

    this.filteredLineNumbers = lineNumbers;
    this.filteredStarts = starts;
    this.filteredEnds = ends;

    onProgress?.({
      phase: 'filtering',
      processed: totalLines,
      total: totalLines,
      matched: lineNumbers.length,
      detail: 'Filter complete'
    });

    return {
      totalLines,
      matchedLines: lineNumbers.length,
      maxLineNumber: lineNumbers.length > 0 ? lineNumbers[lineNumbers.length - 1] : 0
    };
  }

  private filterWithExternalTool(
    filterText: string,
    backend: Exclude<FilterBackend, 'js'>,
    caseSensitive: boolean,
    onMatch: (lineNumber: number) => void,
    totalLines: number,
    onProgress?: (update: ProgressUpdate) => void
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const caseFlag = caseSensitive ? [] : ['-i'];
      const args =
        backend === 'rg'
          ? [
              ...caseFlag,
              '--no-messages',
              '--line-number',
              '--no-filename',
              '--color',
              'never',
              '--text',
              '-e',
              filterText,
              this.uri.fsPath
            ]
          : [...caseFlag, '-n', '-E', '-a', '--color=never', '-e', filterText, this.uri.fsPath];

      const proc = spawn(backend, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let buffer = '';
      let stderr = '';
      let cancelled = false;
      let matched = 0;
      const progressTimer = setInterval(() => {
        onProgress?.({
          phase: 'filtering',
          processed: 0,
          total: totalLines,
          matched,
          detail: `Filtering with ${backend}`
        });
      }, 300);

      this.activeFilterTask = {
        cancel: () => {
          cancelled = true;
          proc.kill();
        }
      };

      const parseLine = (line: string) => {
        if (!line) {
          return;
        }
        const colonIndex = line.indexOf(':');
        if (colonIndex < 0) {
          return;
        }
        const lineNumber = Number.parseInt(line.slice(0, colonIndex), 10);
        if (!Number.isFinite(lineNumber)) {
          return;
        }
        matched += 1;
        onMatch(lineNumber);
      };

      proc.stdout.on('data', (chunk: Buffer | string) => {
        if (cancelled) {
          return;
        }
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const data = buffer + text;
        const parts = data.split(/\r?\n/);
        buffer = parts.pop() ?? '';
        for (const line of parts) {
          parseLine(line);
        }
      });

      proc.stderr.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (stderr.length < 2000) {
          stderr += text;
        }
      });

      proc.on('error', (error) => {
        clearInterval(progressTimer);
        if (cancelled) {
          resolve();
          return;
        }
        reject(error);
      });

      proc.on('close', (exitCode) => {
        clearInterval(progressTimer);
        this.activeFilterTask = null;
        if (cancelled) {
          resolve();
          return;
        }

        if (buffer.length > 0) {
          parseLine(buffer);
        }

        // rg/grep exit code 1 means "no matches".
        if (exitCode !== null && exitCode > 1) {
          reject(new Error(stderr.trim() || `Failed to run ${backend}.`));
          return;
        }
        onProgress?.({
          phase: 'filtering',
          processed: totalLines,
          total: totalLines,
          matched,
          detail: `Filtered with ${backend}`
        });
        resolve();
      });
    });
  }

  private filterWithJs(
    filterText: string,
    caseSensitive: boolean,
    onMatch: (lineNumber: number) => void,
    totalLines: number,
    onProgress?: (update: ProgressUpdate) => void
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let regex: RegExp;
      try {
        regex = caseSensitive ? new RegExp(filterText) : new RegExp(filterText, 'i');
      } catch {
        reject(new Error('Invalid filter regex.'));
        return;
      }

      const stream = fs.createReadStream(this.uri.fsPath, {
        encoding: 'utf8',
        highWaterMark: 64 * 1024
      });
      let cancelled = false;
      let buffer = '';
      let lineNumber = 0;
      let matched = 0;
      let lastProgressAt = Date.now();

      this.activeFilterTask = {
        cancel: () => {
          cancelled = true;
          stream.destroy();
        }
      };

      const pushLine = (line: string) => {
        lineNumber += 1;
        regex.lastIndex = 0;
        if (regex.test(line)) {
          matched += 1;
          onMatch(lineNumber);
        }
        const now = Date.now();
        if (now - lastProgressAt >= 250) {
          onProgress?.({
            phase: 'filtering',
            processed: lineNumber,
            total: totalLines,
            matched,
            detail: 'Filtering with JS'
          });
          lastProgressAt = now;
        }
      };

      stream.on('data', (chunk: string | Buffer) => {
        if (cancelled) {
          return;
        }
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const data = buffer + text;
        const parts = data.split(/\r?\n/);
        buffer = parts.pop() ?? '';
        for (const line of parts) {
          pushLine(line);
        }
      });

      stream.on('error', (error) => {
        this.activeFilterTask = null;
        if (cancelled) {
          resolve();
          return;
        }
        reject(error);
      });

      stream.on('end', () => {
        this.activeFilterTask = null;
        if (cancelled) {
          resolve();
          return;
        }
        if (buffer.length > 0) {
          pushLine(buffer);
        }
        onProgress?.({
          phase: 'filtering',
          processed: totalLines,
          total: totalLines,
          matched,
          detail: 'Filtered with JS'
        });
        resolve();
      });
    });
  }

  async getFilteredSlice(start: number, count: number): Promise<LinePayload[]> {
    await this.ensureIndexed();

    const safeStart = Math.max(0, start);
    const safeCount = Math.max(0, count);
    const safeEnd = Math.min(this.filteredStarts.length, safeStart + safeCount);
    if (safeStart >= safeEnd) {
      return [];
    }

    const result: LinePayload[] = [];

    const mergeGapBytes = 256;
    const maxMergedBytes = 512 * 1024;
    type ReadSegment = {
      startIndex: number;
      endIndex: number;
      byteStart: number;
      byteEnd: number;
    };

    const segments: ReadSegment[] = [];
    let segmentStartIndex = safeStart;
    let segmentEndIndex = safeStart;
    let segmentByteStart = this.filteredStarts[safeStart];
    let segmentByteEnd = this.filteredEnds[safeStart];

    for (let i = safeStart + 1; i < safeEnd; i += 1) {
      const nextStart = this.filteredStarts[i];
      const nextEnd = this.filteredEnds[i];
      const gap = Math.max(0, nextStart - segmentByteEnd);
      const mergedBytes = nextEnd - segmentByteStart;
      const canMerge = gap <= mergeGapBytes && mergedBytes <= maxMergedBytes;

      if (canMerge) {
        segmentEndIndex = i;
        if (nextEnd > segmentByteEnd) {
          segmentByteEnd = nextEnd;
        }
      } else {
        segments.push({
          startIndex: segmentStartIndex,
          endIndex: segmentEndIndex,
          byteStart: segmentByteStart,
          byteEnd: segmentByteEnd
        });
        segmentStartIndex = i;
        segmentEndIndex = i;
        segmentByteStart = nextStart;
        segmentByteEnd = nextEnd;
      }
    }

    segments.push({
      startIndex: segmentStartIndex,
      endIndex: segmentEndIndex,
      byteStart: segmentByteStart,
      byteEnd: segmentByteEnd
    });

    const handle = await fs.promises.open(this.uri.fsPath, 'r');
    try {
      for (const segment of segments) {
        const segmentLength = Math.max(0, segment.byteEnd - segment.byteStart);
        const segmentBuffer = segmentLength > 0 ? Buffer.allocUnsafe(segmentLength) : Buffer.alloc(0);
        if (segmentLength > 0) {
          await handle.read(segmentBuffer, 0, segmentLength, segment.byteStart);
        }

        for (let i = segment.startIndex; i <= segment.endIndex; i += 1) {
          const byteStart = this.filteredStarts[i] - segment.byteStart;
          const byteEnd = this.filteredEnds[i] - segment.byteStart;
          const startOffset = Math.max(0, byteStart);
          const endOffset = Math.max(startOffset, byteEnd);
          const text = segmentBuffer.toString('utf8', startOffset, endOffset);
          result.push({
            i,
            n: this.filteredLineNumbers[i],
            t: text
          });
        }
      }
      return result;
    } finally {
      await handle.close();
    }
  }

  getFilteredLineNumber(index: number): number {
    return this.filteredLineNumbers[index] ?? -1;
  }

  findClosestFilteredIndex(lineNumber: number): { index: number; exact: boolean } {
    if (this.filteredLineNumbers.length === 0) {
      return { index: -1, exact: false };
    }

    let lo = 0;
    let hi = this.filteredLineNumbers.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const current = this.filteredLineNumbers[mid];
      if (current === lineNumber) {
        return { index: mid, exact: true };
      }
      if (current < lineNumber) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (lo >= this.filteredLineNumbers.length) {
      return { index: this.filteredLineNumbers.length - 1, exact: false };
    }
    if (hi < 0) {
      return { index: 0, exact: false };
    }

    const loDiff = Math.abs(this.filteredLineNumbers[lo] - lineNumber);
    const hiDiff = Math.abs(this.filteredLineNumbers[hi] - lineNumber);
    return { index: loDiff < hiDiff ? lo : hi, exact: false };
  }

  async searchFilteredLines(
    query: string,
    caseSensitive: boolean,
    fromFilteredIndex: number,
    fromMatchStart: number,
    fromMatchLength: number,
    direction: 'next' | 'prev'
  ): Promise<{ filteredIndex: number; matchStart: number; matchLength: number } | null> {
    await this.ensureIndexed();
    const total = this.filteredLineNumbers.length;
    if (total === 0 || !query) {
      return null;
    }

    const needle = caseSensitive ? query : query.toLowerCase();

    const handle = await fs.promises.open(this.uri.fsPath, 'r');
    try {
      type Segment = { startIndex: number; endIndex: number; byteStart: number; byteEnd: number };

      const readLine = async (fi: number): Promise<string> => {
        const len = Math.max(0, this.filteredEnds[fi] - this.filteredStarts[fi]);
        if (len === 0) { return ''; }
        const buf = Buffer.allocUnsafe(len);
        await handle.read(buf, 0, len, this.filteredStarts[fi]);
        return buf.toString('utf8');
      };

      const searchRange = async (
        rangeStart: number,
        rangeEnd: number,
        reverse: boolean
      ): Promise<{ filteredIndex: number; matchStart: number; matchLength: number } | null> => {
        if (rangeStart >= rangeEnd) {
          return null;
        }

        const mergeGapBytes = 256;
        const maxMergedBytes = 512 * 1024;
        const segments: Segment[] = [];

        let segStart = rangeStart;
        let segEnd = rangeStart;
        let segByteStart = this.filteredStarts[rangeStart];
        let segByteEnd = this.filteredEnds[rangeStart];

        for (let i = rangeStart + 1; i < rangeEnd; i++) {
          const nextStart = this.filteredStarts[i];
          const nextEnd = this.filteredEnds[i];
          const gap = Math.max(0, nextStart - segByteEnd);
          const mergedBytes = nextEnd - segByteStart;
          if (gap <= mergeGapBytes && mergedBytes <= maxMergedBytes) {
            segEnd = i;
            if (nextEnd > segByteEnd) {
              segByteEnd = nextEnd;
            }
          } else {
            segments.push({ startIndex: segStart, endIndex: segEnd, byteStart: segByteStart, byteEnd: segByteEnd });
            segStart = i;
            segEnd = i;
            segByteStart = nextStart;
            segByteEnd = nextEnd;
          }
        }
        segments.push({ startIndex: segStart, endIndex: segEnd, byteStart: segByteStart, byteEnd: segByteEnd });

        if (reverse) {
          segments.reverse();
        }

        for (const seg of segments) {
          const segLen = Math.max(0, seg.byteEnd - seg.byteStart);
          const buf = segLen > 0 ? Buffer.allocUnsafe(segLen) : Buffer.alloc(0);
          if (segLen > 0) {
            await handle.read(buf, 0, segLen, seg.byteStart);
          }

          const indices: number[] = [];
          for (let fi = seg.startIndex; fi <= seg.endIndex; fi++) {
            indices.push(fi);
          }
          if (reverse) {
            indices.reverse();
          }

          for (const fi of indices) {
            const lineByteStart = this.filteredStarts[fi] - seg.byteStart;
            const lineByteEnd = this.filteredEnds[fi] - seg.byteStart;
            const start = Math.max(0, lineByteStart);
            const end = Math.max(start, lineByteEnd);
            const text = buf.toString('utf8', start, end);
            const haystack = caseSensitive ? text : text.toLowerCase();
            if (reverse) {
              const pos = haystack.lastIndexOf(needle);
              if (pos >= 0) {
                return { filteredIndex: fi, matchStart: pos, matchLength: query.length };
              }
            } else {
              const pos = haystack.indexOf(needle);
              if (pos >= 0) {
                return { filteredIndex: fi, matchStart: pos, matchLength: query.length };
              }
            }
          }
        }
        return null;
      };

      if (direction === 'next') {
        // Check same line first: look for a match after fromMatchStart + fromMatchLength
        if (fromFilteredIndex >= 0 && fromFilteredIndex < total && fromMatchStart >= 0) {
          const text = await readLine(fromFilteredIndex);
          const haystack = caseSensitive ? text : text.toLowerCase();
          const searchFrom = fromMatchStart + Math.max(1, fromMatchLength);
          const pos = haystack.indexOf(needle, searchFrom);
          if (pos >= 0) {
            return { filteredIndex: fromFilteredIndex, matchStart: pos, matchLength: query.length };
          }
        }
        // Continue from the next line
        const nextLine = fromFilteredIndex >= 0 ? fromFilteredIndex + 1 : 0;
        const startAt = nextLine >= total ? 0 : nextLine;
        let result = await searchRange(startAt, total, false);
        if (!result && startAt > 0) {
          result = await searchRange(0, startAt, false);
        }
        return result;
      } else {
        // Check same line first: look for a match before fromMatchStart
        if (fromFilteredIndex >= 0 && fromFilteredIndex < total && fromMatchStart > 0) {
          const text = await readLine(fromFilteredIndex);
          const haystack = caseSensitive ? text : text.toLowerCase();
          const pos = haystack.lastIndexOf(needle, fromMatchStart - 1);
          if (pos >= 0) {
            return { filteredIndex: fromFilteredIndex, matchStart: pos, matchLength: query.length };
          }
        }
        // Continue from the previous line
        const prevLine = fromFilteredIndex > 0 ? fromFilteredIndex - 1 : total - 1;
        const startAt = prevLine;
        let result = await searchRange(0, startAt + 1, true);
        if (!result) {
          result = await searchRange(startAt + 1, total, true);
        }
        return result;
      }
    } finally {
      await handle.close();
    }
  }
}
