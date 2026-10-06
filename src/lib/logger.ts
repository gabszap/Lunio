import { LogEntry, LogLevel } from '../types/media';

type LogListener = (logs: LogEntry[]) => void;

/**
 * Checks if an object is a DOM Node, Window, Document, or React Fiber structure
 */
function isDOMOrFiber(obj: any): boolean {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return false;
  if (typeof obj.nodeType === 'number') return true;
  if (typeof obj.tagName === 'string') return true;
  if (typeof obj.nodeName === 'string' && obj.nodeName.length > 0 && obj.nodeName !== '#text') return true;
  if (obj.constructor && /Element|Node|Window|Document|Fiber|EventTarget/.test(obj.constructor.name)) return true;
  return false;
}

/**
 * Safely stringifies any object or error without throwing TypeError: Converting circular structure to JSON
 */
export function safeStringify(value: unknown, indent?: number): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value !== 'object') return String(value);

  if (isDOMOrFiber(value)) {
    const val = value as any;
    const tag = val.tagName ? val.tagName.toLowerCase() : val.constructor?.name || 'Element';
    return `<${tag}${val.id ? `#${val.id}` : ''}>`;
  }

  if (value instanceof Error) {
    return JSON.stringify(
      {
        name: value.name,
        message: value.message,
        code: (value as any).code,
        stack: value.stack,
      },
      null,
      indent
    );
  }

  // Handle DOM Events or synthetic events
  if ('type' in (value as any) && ('target' in (value as any) || 'detail' in (value as any))) {
    const ev = value as any;
    const detailMsg = ev.detail && typeof ev.detail === 'object' ? ev.detail.message : ev.detail;
    return JSON.stringify(
      {
        type: ev.type,
        message: ev.message || detailMsg || 'Media Event',
        code: ev.code || ev.detail?.code,
      },
      null,
      indent
    );
  }

  const seen = new WeakSet();
  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (key && (key.startsWith('__react') || key === 'stateNode')) {
          return undefined;
        }
        if (val && typeof val === 'object') {
          if (isDOMOrFiber(val)) {
            const tag = val.tagName ? val.tagName.toLowerCase() : val.constructor?.name || 'Element';
            return `<${tag}${val.id ? `#${val.id}` : ''}>`;
          }
          if (seen.has(val)) {
            return '[Circular]';
          }
          seen.add(val);
        }
        return val;
      },
      indent
    );
  } catch (err) {
    return `[Object ${(value as any)?.constructor?.name || typeof value}]`;
  }
}

function sanitizeData(data: unknown): unknown {
  if (data === undefined || data === null) return undefined;
  if (typeof data !== 'object') return data;

  if (isDOMOrFiber(data)) {
    const val = data as any;
    const tag = val.tagName ? val.tagName.toLowerCase() : val.constructor?.name || 'Element';
    return `<${tag}${val.id ? `#${val.id}` : ''}>`;
  }

  if (data instanceof Error) {
    return {
      message: data.message,
      name: data.name,
      code: (data as any).code,
    };
  }

  // If it's a MediaError or Event with DOM nodes
  if ('type' in (data as any) && ('target' in (data as any) || 'detail' in (data as any))) {
    const ev = data as any;
    const detailMsg = ev.detail && typeof ev.detail === 'object' ? ev.detail.message : ev.detail;
    return {
      type: ev.type,
      message: ev.message || detailMsg || 'Event',
      code: ev.code || ev.detail?.code,
    };
  }

  try {
    // Round-trip through safeStringify to guarantee JSON-safe plain object
    const str = safeStringify(data);
    return JSON.parse(str);
  } catch {
    return String(data);
  }
}

class PlayerLogger {
  private logs: LogEntry[] = [];
  private listeners = new Set<LogListener>();
  private maxLogs = 300;

  private formatTime(): string {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  private addLog(level: LogLevel, message: string, rawData?: unknown) {
    const data = sanitizeData(rawData);
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: this.formatTime(),
      level,
      message,
      data,
    };

    this.logs = [...this.logs.slice(-(this.maxLogs - 1)), entry];
    this.notify();

    // Also output to browser dev console with formatting safely as strings
    const prefix = `[${entry.timestamp}] [${level.toUpperCase()}]`;
    const dataString = data !== undefined ? (typeof data === 'string' ? data : safeStringify(data)) : '';
    const fullLog = dataString ? `${prefix} ${message} ${dataString}` : `${prefix} ${message}`;
    if (level === 'error') {
      console.error(fullLog);
    } else if (level === 'warn') {
      console.warn(fullLog);
    } else {
      console.log(fullLog);
    }
  }

  public info(message: string, data?: unknown) {
    this.addLog('info', message, data);
  }

  public action(message: string, data?: unknown) {
    this.addLog('action', message, data);
  }

  /** Ajuste do usuário, já formatado: `logger.setting('Velocidade', '1,25x')`. */
  public setting(settingName: string, value: string | number) {
    this.addLog('setting', `${settingName}: ${value}`);
  }

  public warn(message: string, data?: unknown) {
    this.addLog('warn', message, data);
  }

  public error(message: string, data?: unknown) {
    this.addLog('error', message, data);
  }

  public getLogs(): LogEntry[] {
    return this.logs;
  }

  public clear() {
    this.logs = [];
    this.notify();
    this.info('Console cleared');
  }

  public subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    listener(this.logs);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.logs);
    }
  }
}

export const logger = new PlayerLogger();
