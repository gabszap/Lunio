import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { safeStringify } from './lib/logger';

// Global guard against circular structure exceptions in AI Studio iframe console bridges
(() => {
  if (typeof window === 'undefined') return;

  const sanitizeArg = (arg: unknown): unknown => {
    if (arg && typeof arg === 'object') {
      try {
        const isDom =
          typeof (arg as any).nodeType === 'number' ||
          (arg as any).constructor?.name?.includes('Element') ||
          (arg as any).constructor?.name === 'FiberNode';
        if (isDom) {
          const tag = (arg as any).tagName?.toLowerCase() || (arg as any).constructor?.name || 'Element';
          return `<${tag}${(arg as any).id ? `#${(arg as any).id}` : ''}>`;
        }
      } catch {
        return '[DOM Object]';
      }
    }
    return arg;
  };

  const origError = console.error;
  const origWarn = console.warn;

  console.error = function (...args: any[]) {
    try {
      origError.apply(console, args.map(sanitizeArg));
    } catch {
      try {
        origError.call(console, args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' '));
      } catch {
        // Fallback to plain string message
        origError.call(console, '[Captured Error Event]');
      }
    }
  };

  console.warn = function (...args: any[]) {
    try {
      origWarn.apply(console, args.map(sanitizeArg));
    } catch {
      try {
        origWarn.call(console, args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' '));
      } catch {
        origWarn.call(console, '[Captured Warning Event]');
      }
    }
  };
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
