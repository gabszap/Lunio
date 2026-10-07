import React, { useState, useEffect, useRef } from 'react';
import { Terminal, Trash2, ArrowDownToLine, Copy, Check, FileText, Download, List, ChevronDown } from 'lucide-react';
import { LogEntry, LogLevel } from '../types/media';
import { logger, safeStringify } from '../lib/logger';
import { t } from '../lib/i18n';

export const PlayerConsole: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filterLevel, setFilterLevel] = useState<string>('all');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);
  const [rawViewMode, setRawViewMode] = useState<boolean>(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const rawTextAreaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const unsubscribe = logger.subscribe((newLogs) => {
      setLogs([...newLogs]);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!rawViewMode && autoScroll && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll, rawViewMode]);

  const filteredLogs = logs.filter((log) => {
    if (filterLevel === 'all') return true;
    return log.level === filterLevel;
  });

  const getLogPlainText = (): string => {
    return filteredLogs
      .map(
        (log) =>
          `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}${
            log.data !== undefined ? ' ' + safeStringify(log.data) : ''
          }`
      )
      .join('\n');
  };

  const copyToClipboard = async (text: string): Promise<boolean> => {
    // 1. Tentar Clipboard API moderna
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Continua para o fallback
      }
    }

    // 2. Fallback clássico para iframes / Discord
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      textArea.setAttribute('readonly', '');
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      textArea.setSelectionRange(0, text.length);
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      if (successful) return true;
    } catch {
      // Continua se falhar
    }

    return false;
  };

  const handleCopyLogs = async () => {
    const text = getLogPlainText();
    const success = await copyToClipboard(text);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      // Se não conseguir copiar automaticamente no iframe, abre a visão RAW para copiar manualmente
      setRawViewMode(true);
      setTimeout(() => {
        if (rawTextAreaRef.current) {
          rawTextAreaRef.current.select();
        }
      }, 100);
    }
  };

  const handleDownloadLogs = () => {
    const text = getLogPlainText();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `streamplayer-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleSelectAllRaw = () => {
    if (rawTextAreaRef.current) {
      rawTextAreaRef.current.focus();
      rawTextAreaRef.current.select();
    }
  };

  const levelColor = (level: LogLevel) => {
    switch (level) {
      case 'info':
        return 'text-lu-blue';
      case 'action':
        return 'text-lu-accent';
      case 'setting':
        return 'text-lu-success';
      case 'warn':
        return 'text-lu-warning';
      case 'error':
        return 'text-lu-error';
      default:
        return 'text-lu-muted';
    }
  };

  const toolBtn = (active = false) =>
    `inline-flex items-center justify-center w-9 h-9 rounded-[10px] transition-colors ${
      active ? 'bg-lu-tint text-lu-accent' : 'text-lu-muted hover:bg-white/8'
    }`;

  return (
    <section
      id="player-console-container"
      aria-label={t('Console do player')}
      className="w-full rounded-[14px] bg-lu-surface border border-lu-border overflow-hidden"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap pl-4 pr-3 py-2.5 border-b border-lu-border">
        <div className="flex items-center gap-2.5">
          <span className="flex text-lu-muted">
            <Terminal size={16} />
          </span>
          <h2 className="m-0 text-[14px] font-semibold">{t('Console do player')}</h2>
          <span className="text-[12px] text-lu-muted tabular">
            {logs.length} {logs.length === 1 ? 'evento' : 'eventos'}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <div className="relative">
            <select
              aria-label={t('Filtrar nível de logs')}
              value={filterLevel}
              onChange={(e) => setFilterLevel(e.target.value)}
              className="appearance-none h-9 pl-3 pr-[30px] rounded-md bg-lu-bg2 border border-lu-border text-lu-muted font-[inherit] text-[12px]"
            >
              <option value="all">{t('Todos os níveis')}</option>
              <option value="info">INFO</option>
              <option value="action">ACTION</option>
              <option value="setting">SETTING</option>
              <option value="warn">WARN</option>
              <option value="error">ERROR</option>
            </select>
            <span className="absolute right-2 inset-y-0 flex items-center pointer-events-none text-lu-muted">
              <ChevronDown size={14} />
            </span>
          </div>
          <button
            type="button"
            aria-label={rawViewMode ? t('Voltar para a lista') : t('Modo texto puro')}
            title={rawViewMode ? t('Voltar para a lista') : t('Modo texto puro')}
            aria-pressed={rawViewMode}
            onClick={() => setRawViewMode(!rawViewMode)}
            className={toolBtn(rawViewMode)}
          >
            {rawViewMode ? <List size={16} /> : <FileText size={16} />}
          </button>
          {!rawViewMode && (
            <button
              type="button"
              aria-label={autoScroll ? t('Auto-scroll ativo') : t('Auto-scroll desligado')}
              title={autoScroll ? t('Auto-scroll ativo') : t('Auto-scroll desligado')}
              aria-pressed={autoScroll}
              onClick={() => setAutoScroll(!autoScroll)}
              className={toolBtn(autoScroll)}
            >
              <ArrowDownToLine size={16} />
            </button>
          )}
          <button
            id="btn-console-copy"
            type="button"
            aria-label={copied ? t('Logs copiados') : t('Copiar logs')}
            title={copied ? t('Logs copiados') : t('Copiar logs')}
            onClick={handleCopyLogs}
            className={toolBtn(copied)}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
          <button type="button" aria-label={t('Baixar logs')} title={t('Baixar logs')} onClick={handleDownloadLogs} className={toolBtn()}>
            <Download size={16} />
          </button>
          <button id="btn-console-clear" type="button" aria-label={t('Limpar logs')} title={t('Limpar logs')} onClick={() => logger.clear()} className={toolBtn()}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {rawViewMode ? (
        <div className="p-3 bg-lu-bg2 flex flex-col gap-2">
          <div className="flex items-center justify-between text-[12px] text-lu-muted">
            <span>{t('Clique dentro e use Ctrl+A / Ctrl+C, ou:')}</span>
            <button type="button" onClick={handleSelectAllRaw} className="text-lu-accent font-semibold hover:text-lu-accent-hover">
              {t('Selecionar tudo')}
            </button>
          </div>
          <textarea
            ref={rawTextAreaRef}
            readOnly
            aria-label={t('Logs em texto puro')}
            value={getLogPlainText()}
            rows={10}
            className="w-full box-border bg-lu-bg border border-lu-border rounded-[10px] p-2.5 text-lu-text font-mono text-[12px] leading-relaxed custom-scrollbar resize-y select-text"
            style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
          />
        </div>
      ) : (
        <div
          id="player-console-logs-window"
          ref={scrollContainerRef}
          className="h-[168px] overflow-y-auto px-4 py-3 bg-lu-bg2 font-mono custom-scrollbar select-text cursor-text"
          style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
        >
          {filteredLogs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-lu-disabled text-[12px]">{t('Nenhum evento registrado ainda.')}</div>
          ) : (
            filteredLogs.map((log) => (
              <div key={log.id} className="flex gap-3 text-[12px] leading-[1.7]">
                <span className="text-lu-disabled flex-none select-none">{log.timestamp}</span>
                <span className={`w-14 flex-none font-semibold uppercase select-none ${levelColor(log.level)}`}>{log.level}</span>
                <span className="text-lu-text min-w-0 break-words">
                  {log.message}
                  {log.data !== undefined && <span className="text-lu-disabled ml-1.5">{safeStringify(log.data)}</span>}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
};
