import type { ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/**
 * Resposta de erro para o cliente: só um código estável e uma frase genérica.
 * Nunca inclui stack, caminhos, stderr do FFmpeg nem a URL (que pode carregar token). O detalhe vai pro log.
 */
export function sendApiError(res: ServerResponse, status: number, code: string, message?: string) {
  sendJson(res, status, { error: message || ERROR_MESSAGES[code] || 'Erro inesperado no servidor.', code });
}

const ERROR_MESSAGES: Record<string, string> = {
  bad_request: 'Pedido inválido.',
  unauthorized: 'Sessão ausente ou expirada. Recarregue a página.',
  forbidden: 'Você não tem permissão para isso.',
  not_found: 'Não encontrado.',
  method_not_allowed: 'Método não permitido.',
  rate_limited: 'Muitos pedidos. Tente de novo em instantes.',
  busy: 'O servidor está ocupado. Tente de novo em instantes.',
  url_blocked: 'Esse endereço não pode ser acessado pelo servidor.',
  upstream_failed: 'Não foi possível acessar o vídeo de origem.',
  too_large: 'Arquivo grande demais.',
  quota_exceeded: 'O servidor não tem mais espaço para envios.',
  upload_in_progress: 'Já existe um envio em andamento nesta sala.',
  not_host: 'Só o Host da sala pode enviar arquivos.',
  EXTRACTION_FAILED: 'Não foi possível extrair a legenda.',
  BITMAP_NOT_SUPPORTED: 'Esse formato de legenda (imagem) não é suportado.',
  internal: 'Erro inesperado no servidor.',
};

/** Remove `?token=…`/credenciais de uma URL antes de logar. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    const keep = u.search ? '?…' : '';
    return `${u.origin}${u.pathname.length > 80 ? u.pathname.slice(0, 80) + '…' : u.pathname}${keep}`;
  } catch {
    return '(url inválida)';
  }
}
