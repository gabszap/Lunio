import { DiscordSDK, patchUrlMappings } from '@discord/embedded-app-sdk';
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
      this.sdk = new DiscordSDK(appClientId);

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
          scope: ['identify', 'guilds', 'rpc.activities.write'],
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

  private presenceBase: { title?: string; people: number } = { people: 1 };
  private playback: { paused: boolean; position: number; duration: number } | null = null;
  private sentPresence: { key: string; start?: number } = { key: '' };
  private presenceStart = Math.floor(Date.now() / 1000);

  /** Rich Presence ("Jogando Lunio"): título do vídeo e quantas pessoas estão na sala. Falha em silêncio (scope não concedido). */
  public setPresence(opts: { title?: string; people: number }) {
    this.presenceBase = opts;
    if (!opts.title) this.playback = null;
    void this.pushPresence();
  }

  /** Ponto do vídeo: tocando mostra "restante" no contador do Discord; pausado mostra a posição no texto. */
  public setPlayback(pb: { paused: boolean; position: number; duration: number } | null) {
    this.playback = pb;
    void this.pushPresence();
  }

  private async pushPresence(): Promise<void> {
    if (!this.sdk || !this.state.user || this.state.user.id === 'mock_discord_user') return;
    const { title, people } = this.presenceBase;
    const pb = title ? this.playback : null;
    const hasTimeline = !!pb && pb.duration > 0;
    const playing = hasTimeline && !pb!.paused;
    const start = playing ? Math.floor(Date.now() / 1000 - pb!.position) : undefined;

    const room = people > 1 ? `Em sala com ${people} pessoas` : 'Sozinho na sala';
    const state = hasTimeline && pb!.paused ? `Pausado em ${fmtClock(pb!.position)} de ${fmtClock(pb!.duration)} · ${room}` : room;
    const key = JSON.stringify({ title, state, playing, hasTimeline });
    // Tocando: só reenvia se o início calculado mudou (seek/pausa), não a cada tick
    if (key === this.sentPresence.key && (!playing || Math.abs((start ?? 0) - (this.sentPresence.start ?? 0)) <= 3)) return;
    this.sentPresence = { key, start };

    const timestamps = playing ? { start: start!, end: start! + Math.floor(pb!.duration) } : { start: this.presenceStart };
    const activity = {
      type: 0,
      details: title ? `Assistindo ${title}`.slice(0, 128) : 'Escolhendo um vídeo',
      state: state.slice(0, 128),
      timestamps,
    };
    try {
      await this.sdk.commands.setActivity({ activity: activity as never });
    } catch (e: any) {
      logger.warn('[Discord] Não deu pra atualizar a Rich Presence:', e?.message);
    }
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

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
