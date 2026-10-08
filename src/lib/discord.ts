// O SDK (~200 kB) só é baixado quando o app roda dentro de uma Discord Activity
import type { DiscordSDK } from '@discord/embedded-app-sdk';
import { logger } from './logger';

export interface DiscordUser {
  id: string;
  username: string;
  discriminator?: string;
  globalName?: string;
  avatar?: string;
  avatarUrl?: string;
}

export interface DiscordContextState {
  isEmbedded: boolean;
  isReady: boolean;
  user: DiscordUser | null;
  channelId: string | null;
  guildId: string | null;
  instanceId: string | null;
  platform: string;
  error?: string | null;
}

class DiscordActivityManager {
  private sdk: DiscordSDK | null = null;
  private state: DiscordContextState = {
    isEmbedded: false,
    isReady: false,
    user: null,
    channelId: null,
    guildId: null,
    instanceId: null,
    platform: 'web',
    error: null,
  };
  private listeners = new Set<(state: DiscordContextState) => void>();

  constructor() {
    this.detectEnvironment();
  }

  /**
   * Detecta se o app está rodando dentro do iframe da Discord Activity
   */
  public isDiscordActivity(): boolean {
    if (typeof window === 'undefined') return false;
    const urlParams = new URLSearchParams(window.location.search);
    const hasFrameId = urlParams.has('frame_id');
    const isDiscordDomain = window.location.hostname.includes('discordsays.com') ||
      window.location.hostname.includes('discord.com');
    const isIframe = window.parent !== window;

    return hasFrameId || (isIframe && isDiscordDomain);
  }

  private detectEnvironment() {
    const isEmbedded = this.isDiscordActivity();
    this.state.isEmbedded = isEmbedded;

    if (!isEmbedded) {
      // Modo navegador standalone tradicional (desenvolvimento / teste direto)
      this.state.isReady = true;
      this.state.user = null;
      this.state.platform = 'browser';
      logger.info('[Discord] Rodando no navegador, fora do Discord');
    }
  }

  /**
   * Inicializa o Discord Embedded App SDK se estiver dentro de uma Activity
   */
  public async initialize(clientId?: string): Promise<DiscordContextState> {
    if (!this.state.isEmbedded) {
      this.notify();
      return this.state;
    }

    const appClientId = clientId || (import.meta.env.VITE_DISCORD_CLIENT_ID as string) || '';
    if (!appClientId) {
      logger.warn('[Discord] VITE_DISCORD_CLIENT_ID não configurado; Activity em modo de teste');
      this.state.isReady = true;
      this.state.user = {
        id: 'mock_discord_user',
        username: 'Discord Guest',
        globalName: 'Convidado Discord',
      };
      this.notify();
      return this.state;
    }

    try {
      logger.info(`[Discord] Iniciando o SDK (Client ID: ${appClientId})…`);
      const { DiscordSDK: DiscordSDKClass, patchUrlMappings } = await import('@discord/embedded-app-sdk');
      this.sdk = new DiscordSDKClass(appClientId);

      // Fase 4 — Discord Networking: Patch URL Mappings
      // Permite que chamadas para /api passem pelo proxy transparente do Discord
      const currentOrigin = window.location.origin;
      patchUrlMappings([
        { prefix: '/api', target: `${currentOrigin}/api` },
        { prefix: '/.proxy/api', target: `${currentOrigin}/api` },
        { prefix: '/ws', target: `${currentOrigin}/ws` },
        { prefix: '/.proxy/ws', target: `${currentOrigin}/ws` },
      ], {
        patchFetch: true,
        patchWebSocket: true,
        patchXhr: true,
        patchSrcAttributes: true,
      });

      // Handshake com o cliente do Discord
      await this.sdk.ready();
      logger.info('[Discord] SDK conectado');

      const urlParams = new URLSearchParams(window.location.search);
      this.state.channelId = this.sdk.channelId || urlParams.get('channel_id');
      this.state.guildId = this.sdk.guildId || urlParams.get('guild_id');
      this.state.instanceId = this.sdk.instanceId || urlParams.get('instance_id');
      this.state.platform = this.sdk.platform || 'discord';
      this.state.isReady = true;

      // Autenticação OAuth2 para captura do perfil real de usuário e avatar do Discord
      try {
        const { code } = await this.sdk.commands.authorize({
          client_id: appClientId,
          response_type: 'code',
          state: '',
          prompt: 'none',
          scope: ['identify', 'guilds'],
        });

        if (code) {
          logger.info('[Discord] Autorizado; trocando o código por token…');
          try {
            const tokenRes = await fetch('/api/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code }),
            });

            if (tokenRes.ok) {
              const tokenData = await tokenRes.json();
              if (tokenData.access_token) {
                const auth = await this.sdk.commands.authenticate({
                  access_token: tokenData.access_token,
                });

                if (auth?.user) {
                  const u = auth.user;
                  const avatarUrl = u.avatar
                    ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`
                    : undefined;

                  this.state.user = {
                    id: u.id,
                    username: u.username,
                    globalName: u.global_name || u.username,
                    discriminator: u.discriminator,
                    avatar: u.avatar,
                    avatarUrl,
                  };
                  logger.info(`[Discord] Conectado como ${this.state.user.globalName} (@${this.state.user.username})`);
                }
              }
            } else {
              logger.info('[Discord] Sem DISCORD_CLIENT_SECRET: entrando como convidado');
            }
          } catch (e: any) {
            logger.warn('[Discord] Falha ao chamar /api/token:', e?.message);
          }
        }
      } catch (authErr) {
        // Modo visitante sem login OAuth obrigatório imediato
        logger.info('[Discord] Entrando como convidado');
      }

      this.notify();
      return this.state;
    } catch (err: any) {
      logger.error('[Discord] Falha ao iniciar o SDK', err);
      this.state.error = err?.message || 'Falha no handshake do Discord SDK';
      this.state.isReady = true; // Permite que a UI continue utilizável mesmo em falha de handshake
      this.notify();
      return this.state;
    }
  }

  public getState(): DiscordContextState {
    return this.state;
  }

  public getSdk(): DiscordSDK | null {
    return this.sdk;
  }

  public subscribe(listener: (state: DiscordContextState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

export const discordManager = new DiscordActivityManager();
