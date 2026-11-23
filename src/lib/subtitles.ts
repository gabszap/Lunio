import { LibASSTextRenderer, MediaPlayerInstance } from '@vidstack/react';
import {
  SubtitleTrack,
  SubtitleCandidate,
  SubtitlePreferences,
  ResolvedMediaRef,
  SubtitleFormat,
  SubtitlePreparationStatus,
} from '../types/media';
import { logger } from './logger';
import { apiFetch } from './access';
import { collectAssFontNames, selectFontsToLoad } from './assFonts';
import { transformAssStyle } from './assStyle';
import { srtToVtt } from './media';
import { sessionManager } from './session';
import { t } from './/i18n';
import { requireSubtitleFormat } from './subtitleFormats';
import { effectiveSubtitleOffset, shiftCueWindow } from './subtitleTiming';
import { observeSubtitlePreparation } from './subtitleProgress';

/**
 * Creates a JASSUB class compatible with Vidstack's LibASSTextRenderer.
 * Vidstack expects the loaded constructor to create an object with:
 * - addEventListener(type, handler)
 * - removeEventListener(type, handler)
 * - setTrackByUrl(url)
 * - freeTrack()
 * JASSUB v2+ does not inherit from EventTarget by default, so we wrap it here.
 */
export async function loadCompatibleJassub(): Promise<{ default: any }> {
  const jassubModule = await import('jassub');
  const JASSUB = jassubModule.default as any;

  // Monkey-patch JASSUB prototype as a safety net
  if (JASSUB && JASSUB.prototype) {
    const proto = JASSUB.prototype;
    if (!proto.addEventListener) {
      proto.addEventListener = function (
        type: string,
        handler: (event: any) => void
      ) {
        this._listeners = this._listeners || {};
        this._listeners[type] = this._listeners[type] || [];
        this._listeners[type].push(handler);

        if (type === 'ready' && this.ready) {
          Promise.resolve(this.ready)
            .then(() => {
              handler(new CustomEvent('ready'));
            })
            .catch((err: any) => {
              const errorHandlers = this._listeners?.['error'];
              if (errorHandlers) {
                errorHandlers.forEach((h: any) => h({ error: err }));
              }
            });
        }
      };
    }

    if (!proto.removeEventListener) {
      proto.removeEventListener = function (
        type: string,
        handler: (event: any) => void
      ) {
        if (this._listeners?.[type]) {
          this._listeners[type] = this._listeners[type].filter(
            (h: any) => h !== handler
          );
        }
      };
    }

    if (!proto.setTrackByUrl) {
      proto.setTrackByUrl = async function (url: string) {
        try {
          const renderer: any = await this.ready;
          if (renderer && typeof renderer.setTrackByUrl === 'function') {
            return await renderer.setTrackByUrl(url);
          }
        } catch {
          // ignore
        }
      };
    }

    if (!proto.freeTrack) {
      proto.freeTrack = async function () {
        try {
          const renderer: any = await this.ready;
          if (renderer && typeof renderer.freeTrack === 'function') {
            return await renderer.freeTrack();
          }
        } catch {
          // ignore
        }
      };
    }
  }

  class CompatibleJASSUB extends JASSUB {
    private _listeners: Record<string, ((event: any) => void)[]> = {};

    constructor(options: any) {
      const sanitizedOptions = { ...options };
      // Prevent fetching empty string as subtitle URL
      if (!sanitizedOptions.subUrl || sanitizedOptions.subUrl === '') {
        delete sanitizedOptions.subUrl;
      }

      super(sanitizedOptions);

      if (this.ready) {
        Promise.resolve(this.ready)
          .then(() => {
            this.dispatchEvent(new CustomEvent('ready'));
          })
          .catch((err: any) => {
            this.dispatchEvent(
              new CustomEvent('error', { detail: { error: err } })
            );
          });
      }
    }

    addEventListener(type: string, handler: (event: any) => void) {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(handler);

      if (type === 'ready' && this.ready) {
        Promise.resolve(this.ready)
          .then(() => {
            handler(new CustomEvent('ready'));
          })
          .catch(() => {});
      }
    }

    removeEventListener(type: string, handler: (event: any) => void) {
      if (this._listeners[type]) {
        this._listeners[type] = this._listeners[type].filter(
          (h) => h !== handler
        );
      }
    }

    dispatchEvent(event: Event | CustomEvent): boolean {
      const handlers = this._listeners[event.type];
      if (handlers) {
        handlers.forEach((h) => {
          try {
            h(event);
          } catch (err) {
            console.error('JASSUB event error:', err);
          }
        });
      }
      return true;
    }

    async setTrackByUrl(url: string) {
      try {
        const renderer: any = await this.ready;
        if (renderer && typeof renderer.setTrackByUrl === 'function') {
          return await renderer.setTrackByUrl(url);
        }
      } catch (err) {
        console.warn('JASSUB setTrackByUrl failed:', err);
      }
    }

    async freeTrack() {
      try {
        const renderer: any = await this.ready;
        if (renderer && typeof renderer.freeTrack === 'function') {
          return await renderer.freeTrack();
        }
      } catch (err) {
        console.warn('JASSUB freeTrack failed:', err);
      }
    }
  }

  return { default: CompatibleJASSUB as any };
}

export interface SubtitleProvider {
  id: string;
  name: string;
  resolve(media: ResolvedMediaRef): Promise<SubtitleCandidate[]>;
}

/**
 * SubtitleResolver (v8):
 * - Camada de descoberta totalmente independente e desacoplada da fonte de vídeo.
 * - Suporta descoberta paralela sem adotar "primeira resposta = vencedora".
 * - Ranking determinístico com prioridade para PT-BR ASS em animes.
 * - Preparação sob demanda pontual com cancelamento atômico de processos redundantes.
 */
/** Falhas que não mudam ao tentar de novo (as transitórias, como 503, podem ser repetidas). */
const PERMANENT_SUBTITLE_ERRORS = new Set(['BITMAP_NOT_SUPPORTED', 'EXTRACTION_FAILED']);

/** Inicializar o LibASS (WASM + fontes) numa conexão lenta (ex.: Tailscale) passou de 25 s e derrubava a legenda escolhida. */
const LIBASS_INIT_TIMEOUT_MS = 90_000;

export class SubtitleResolver {
  private providers: SubtitleProvider[] = [];
  private activeExtractionAbort: AbortController | null = null;
  private candidateCache = new Map<string, SubtitleCandidate>();

  constructor() {
    // 1. Provider para legendas embutidas no MKV (inspecionadas via FFmpeg)
    this.registerProvider({
      id: 'embedded-mkv',
      name: 'MKV Embedded Subtitles',
      resolve: async (media: ResolvedMediaRef) => {
        if (!media.subtitleTracks || media.subtitleTracks.length === 0) return [];
        return media.subtitleTracks.map((st) => {
          const lang = (st.language || 'und').toLowerCase();
          const codec = (st.codec || '').toLowerCase();
          const format: SubtitleFormat =
            st.format ||
            (codec.includes('ass') || codec.includes('ssa')
              ? 'ass'
              : codec.includes('subrip') || codec.includes('srt')
              ? 'srt'
              : codec.includes('vtt')
              ? 'vtt'
              : 'ass');

          return {
            id: `embedded_${media.mediaFingerprint || media.mediaUrl}_${st.index}`,
            language: lang,
            format: 'ass' as const,
            sourceFormat: format,
            source: 'embedded',
            // fingerprint estável: token novo do TorBox não invalida o cache de legendas
            url: `/api/subtitle?url=${encodeURIComponent(media.mediaUrl)}&track=${st.index}${
              media.mediaFingerprint ? `&fingerprint=${encodeURIComponent(media.mediaFingerprint)}` : ''
            }`,
            trackId: st.index,
            confidence: 0,
            forced: !!st.isForced,
            title: st.label || t('Legenda #{index}', { index: st.index }),
            availability: 'known',
          };
        });
      },
    });

    // 2. Provider para fontes externas e Stream Object (Torrentio / Addon / Sidecar)
    this.registerProvider({
      id: 'stream-external',
      name: 'Stream Object / External Subtitles',
      resolve: async (media: ResolvedMediaRef) => {
        if (!media.externalSubtitleSources || media.externalSubtitleSources.length === 0) return [];
        return media.externalSubtitleSources.map((es, idx) => ({
          id: `external_${es.url}_${idx}`,
          language: (es.language || 'und').toLowerCase(),
          format: es.format || 'srt',
          source: es.source || 'stream',
          url: es.url,
          confidence: 0,
          forced: false,
          title: es.title || t('Legenda Externa ({language})', { language: es.language }),
          availability: 'known',
        }));
      },
    });
  }

  public registerProvider(provider: SubtitleProvider) {
    this.providers.push(provider);
  }

  /**
   * Descoberta paralela de todas as fontes disponíveis,
   * seguida de validação e ranking determinístico.
   */
  public async resolveCandidates(
    media: ResolvedMediaRef,
    preferences: SubtitlePreferences = {
      preferredLanguages: ['pt-br', 'por', 'pt', 'en', 'eng'],
      preferAssForAnime: true,
      requireSubtitle: true,
    }
  ): Promise<{
    candidates: SubtitleCandidate[];
    rankedCandidates: SubtitleCandidate[];
    topCandidate: SubtitleCandidate | null;
  }> {
    const results = await Promise.allSettled(
      this.providers.map((p) => p.resolve(media))
    );

    const allCandidates: SubtitleCandidate[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        allCandidates.push(...r.value);
      }
    }

    const rankedCandidates = this.rankCandidates(allCandidates, media, preferences);
    const topCandidate = rankedCandidates.length > 0 ? rankedCandidates[0] : null;

    return {
      candidates: allCandidates,
      rankedCandidates,
      topCandidate,
    };
  }

  /**
   * Algoritmo de validação e ranking:
   * Prioriza deterministicamente PT-BR ASS para anime e avalia dublagem vs faixas forçadas.
   */
  public rankCandidates(
    candidates: SubtitleCandidate[],
    media: ResolvedMediaRef,
    preferences: SubtitlePreferences
  ): SubtitleCandidate[] {
    const defaultAudio = media.audioTracks[0];
    const isDefaultAudioPt = !!(
      defaultAudio &&
      (defaultAudio.language?.includes('por') ||
        defaultAudio.language?.includes('pt') ||
        defaultAudio.label?.toLowerCase().includes('portug'))
    );
    const isJapaneseAudio = media.audioTracks.some(
      (a) => a.language?.includes('jpn') || a.language?.includes('ja') || a.label?.toLowerCase().includes('japon')
    );
    const isAsianOrAnime =
      isJapaneseAudio ||
      media.audioTracks.some((a) => {
        const lang = (a.language || '').toLowerCase();
        const lbl = (a.label || '').toLowerCase();
        return (
          lang.includes('chi') ||
          lang.includes('zh') ||
          lang.includes('kor') ||
          lbl.includes('chin') ||
          lbl.includes('mandar') ||
          lbl.includes('corea')
        );
      });

    const userPreferredLangs = (preferences.preferredLanguages && preferences.preferredLanguages.length > 0)
      ? preferences.preferredLanguages.map((l) => l.toLowerCase())
      : ['pt', 'pt-br', 'en'];

    const scored = candidates.map((cand) => {
      let score = 0;
      const lang = (cand.language || '').toLowerCase();
      const titleLower = (cand.title || '').toLowerCase();

      // 1. Correspondência dinâmica por ordem de preferência do usuário (1000, 600, 360, 216...)
      let matchedLanguageIndex = -1;
      for (let i = 0; i < userPreferredLangs.length; i++) {
        const pref = userPreferredLangs[i];
        if (lang === pref || lang.startsWith(pref) || pref.startsWith(lang)) {
          matchedLanguageIndex = i;
          break;
        }
        if ((pref === 'pt' || pref === 'pt-br') && (titleLower.includes('portug') || titleLower.includes('brasil') || titleLower.includes('brazil'))) {
          matchedLanguageIndex = i;
          break;
        }
        if (pref === 'en' && (titleLower.includes('english') || titleLower.includes('inglês') || titleLower.includes('ingles'))) {
          matchedLanguageIndex = i;
          break;
        }
        if (pref === 'es' && (titleLower.includes('espanhol') || titleLower.includes('spanish') || titleLower.includes('castellano'))) {
          matchedLanguageIndex = i;
          break;
        }
        if (pref === 'fr' && (titleLower.includes('français') || titleLower.includes('francês') || titleLower.includes('french'))) {
          matchedLanguageIndex = i;
          break;
        }
        if (pref === 'ja' && (titleLower.includes('japanese') || titleLower.includes('japonês'))) {
          matchedLanguageIndex = i;
          break;
        }
      }

      if (matchedLanguageIndex !== -1) {
        score += Math.round(1000 * Math.pow(0.6, matchedLanguageIndex));
        // Bônus se for explicitamente PT-BR vs PT-PT
        if ((lang.includes('pt-br') || titleLower.includes('brasil') || titleLower.includes('brazil')) && !titleLower.includes('pt-pt')) {
          score += 150;
        }
      } else {
        score += 30; // Idioma não listado nas preferências
      }

      // 2. Se for anime/animação asiática (JP/CN/KR ou preferência ASS):
      // ASS/SSA ganha preferência máxima para manter karaoke, estilos de fala e placas intactas
      if (isAsianOrAnime || preferences.preferAssForAnime) {
        const sourceFormat = cand.sourceFormat || cand.format;
        if (sourceFormat === 'ass' || sourceFormat === 'ssa') {
          score += 300;
        } else if (sourceFormat === 'srt' || sourceFormat === 'vtt') {
          score += 80;
        }
      }

      // 3. Tratamento de faixas forçadas (placas/sinais)
      if (cand.forced) {
        if (isDefaultAudioPt) {
          // Áudio nativo padrão já é dublado em português: usuário precisa prioritariamente de placas traduzidas
          score += 150;
        } else {
          // Áudio original estrangeiro (japonês, chinês, coreano, etc.): usuário precisa de diálogo completo!
          score -= 500;
        }
      }

      // 4. Hearing Impaired / SDH quando não solicitado
      if (cand.hearingImpaired || titleLower.includes('sdh') || titleLower.includes('cc')) {
        if (!preferences.allowHearingImpaired) {
          score -= 100;
        }
      }

      // 5. Confiabilidade de fonte embutida no release original
      if (cand.source === 'embedded') {
        score += 60;
      }

      // Normaliza para nível de confiança 0 a 100
      cand.confidence = Math.max(0, Math.min(100, Math.round(score / 15)));
      return { candidate: cand, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.candidate);
  }

  /**
   * Prepara sob demanda a candidate selecionada (0ms se em cache).
   * Cancela requisições redundantes anteriores via AbortSignal.
   */
  public async prepareCandidate(
    candidate: SubtitleCandidate,
    signal?: AbortSignal
  ): Promise<SubtitleCandidate> {
    if (candidate.availability === 'ready' && candidate.content) {
      candidate.format = requireSubtitleFormat(candidate.content);
      return candidate;
    }

    // Faixa já conhecida como incompatível (imagem/extração impossível): não repete a requisição
    if (candidate.availability === 'failed' && candidate.errorCode && PERMANENT_SUBTITLE_ERRORS.has(candidate.errorCode)) {
      const known: any = new Error(candidate.errorMessage || t('Legenda indisponível.'));
      known.code = candidate.errorCode;
      throw known;
    }

    if (this.candidateCache.has(candidate.id)) {
      const cached = this.candidateCache.get(candidate.id)!;
      if (cached.content) {
        candidate.content = cached.content;
        candidate.format = requireSubtitleFormat(cached.content);
        candidate.availability = 'ready';
        return candidate;
      }
    }

    this.cancelActivePreparation();

    const controller = new AbortController();
    this.activeExtractionAbort = controller;

    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();

    candidate.availability = 'pending';

    try {
      if (!candidate.url) {
        throw new Error('Candidate não possui URL válida.');
      }

      const res = await apiFetch(candidate.url, {
        signal: controller.signal,
      });

      if (!res.ok) {
        let errMessage = `HTTP ${res.status} ao carregar legenda.`;
        let errCode = `HTTP_${res.status}`;
        try {
          const json = await res.json();
          if (json.error) errMessage = json.error;
          if (json.code) errCode = json.code;
        } catch {}
        const err: any = new Error(errMessage);
        err.code = errCode;
        err.status = res.status;
        throw err;
      }

      const content = await res.text();
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      candidate.format = requireSubtitleFormat(content);
      const declared = res.headers.get('X-Subtitle-Format');
      if (declared && declared !== candidate.format && !(declared === 'ass' && candidate.format === 'ssa')) {
        throw Object.assign(new Error('Formato entregue não corresponde ao declarado.'), { code: 'SUBTITLE_INVALID' });
      }
      candidate.content = content;
      candidate.availability = 'ready';
      candidate.errorCode = undefined;
      candidate.errorMessage = undefined;
      this.candidateCache.set(candidate.id, candidate);
      return candidate;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // Cancelada porque outra candidata foi escolhida: não é defeito da faixa
        candidate.availability = 'known';
        logger.info(`[Legenda] Preparação de "${candidate.title}" cancelada`);
      } else {
        candidate.availability = 'failed';
        candidate.errorCode = err.code || 'EXTRACTION_FAILED';
        candidate.errorMessage = err.message;
      }
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.activeExtractionAbort === controller) {
        this.activeExtractionAbort = null;
      }
    }
  }

  public candidateToTrack(cand: SubtitleCandidate): SubtitleTrack {
    return {
      id: cand.id,
      index: cand.trackId,
      src: cand.url || '',
      label: cand.title,
      language: cand.language,
      type: cand.format === 'ass' || cand.format === 'ssa' ? 'ass' : 'vtt',
      isForced: cand.forced,
      content: cand.content,
      candidate: cand,
    };
  }

  public cancelActivePreparation() {
    if (this.activeExtractionAbort) {
      try {
        this.activeExtractionAbort.abort();
      } catch {}
      this.activeExtractionAbort = null;
    }
  }
}

export const subtitleResolver = new SubtitleResolver();

export class SubtitleManager {
  private preparationGeneration = 0;
  private preparationController: AbortController | null = null;
  private cancelNativeLoad: (() => void) | null = null;
  private libassRenderer: LibASSTextRenderer | null = null;
  private jassubInstance: any = null;
  private nativeTrackEl: HTMLTrackElement | null = null;
  private nativeBlobUrl: string | null = null;
  private nativeOriginalCues: Array<{ cue: TextTrackCue; start: number; end: number }> = [];
  private timelineOriginSec = 0;
  private currentTrack: SubtitleTrack | null = null;
  private isLibassInitialized = false;
  private subtitleDelaySec = 0; // -10.0s to +10.0s
  private fontSizePercent = 100; // 50% to 250%
  private bottomOffsetPercent = 5; // 0% to 30%
  private appearanceGeneration = 0;
  private appearanceTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeCuePositionModified = false;

  constructor() {
    if (typeof window !== 'undefined') {
      const savedDelay = localStorage.getItem('vidstack_player_subtitle_delay');
      if (savedDelay) {
        const parsed = parseFloat(savedDelay);
        if (!isNaN(parsed) && parsed >= -10 && parsed <= 10) {
          this.subtitleDelaySec = parsed;
        }
      }
      const savedSize = localStorage.getItem('vidstack_player_subtitle_font_size');
      if (savedSize) {
        const parsed = parseInt(savedSize, 10);
        if (!isNaN(parsed) && parsed >= 50 && parsed <= 250) {
          this.fontSizePercent = parsed;
        }
      }
      const savedOffset = localStorage.getItem('vidstack_player_subtitle_bottom_offset');
      if (savedOffset) {
        const parsed = parseInt(savedOffset, 10);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 30) {
          this.bottomOffsetPercent = parsed;
        }
      }
      this.applyCssVariables();
    }
  }

  public getSubtitleDelay(): number {
    return this.subtitleDelaySec;
  }

  public getFontSize(): number {
    return this.fontSizePercent;
  }

  public getBottomOffset(): number {
    return this.bottomOffsetPercent;
  }

  public setSubtitleDelay(seconds: number) {
    const clamped = Math.max(-10.0, Math.min(10.0, Number(seconds.toFixed(3))));
    this.subtitleDelaySec = clamped;
    if (typeof window !== 'undefined') {
      localStorage.setItem('vidstack_player_subtitle_delay', clamped.toString());
    }
    this.applySubtitleOffset();
    logger.setting('Sincronia da legenda', `${Math.round(clamped * 1000)} ms`);
  }

  public setFontSize(percent: number) {
    const clamped = Math.max(50, Math.min(250, percent));
    this.fontSizePercent = clamped;
    if (typeof window !== 'undefined') {
      localStorage.setItem('vidstack_player_subtitle_font_size', clamped.toString());
    }
    this.reapplySubtitleAppearance();
    logger.setting('Tamanho da legenda', `${clamped}%`);
  }

  public setBottomOffset(percent: number) {
    const clamped = Math.max(0, Math.min(30, percent));
    this.bottomOffsetPercent = clamped;
    if (typeof window !== 'undefined') {
      localStorage.setItem('vidstack_player_subtitle_bottom_offset', clamped.toString());
    }
    this.reapplySubtitleAppearance();
    logger.setting('Posição da legenda', `${clamped}%`);
  }

  private reapplySubtitleAppearance() {
    this.applyCssVariables();
    this.applyNativeCuePosition();
    const gen = ++this.appearanceGeneration;
    if (this.appearanceTimer) {
      clearTimeout(this.appearanceTimer);
      this.appearanceTimer = null;
    }
    const instance = this.jassubInstance;
    const track = this.currentTrack;
    if (!instance || !track?.content || (track.type !== 'ass' && track.type !== 'ssa')) {
      return;
    }
    this.appearanceTimer = setTimeout(() => {
      this.appearanceTimer = null;
      if (gen !== this.appearanceGeneration || this.jassubInstance !== instance || this.currentTrack !== track) return;
      const styled = transformAssStyle(track.content!, this.fontSizePercent, this.bottomOffsetPercent);
      void Promise.resolve(instance.ready)
        .then(async () => {
          if (gen !== this.appearanceGeneration || this.jassubInstance !== instance || this.currentTrack !== track) return;
          if (instance.renderer && typeof instance.renderer.setTrack === 'function') {
            await instance.renderer.setTrack(styled);
          } else if (typeof instance.setTrack === 'function') {
            await instance.setTrack(styled);
          }
          if (gen !== this.appearanceGeneration || this.jassubInstance !== instance) return;
          await this.forceJassubRepaint(instance);
        })
        .catch(() => {
          // fallback silencioso se o worker ainda estiver iniciando ou for descartado
        });
    }, 16);
  }

  private async forceJassubRepaint(instance: any) {
    if (!instance || this.jassubInstance !== instance) return;
    try {
      await Promise.resolve(instance.ready);
      if (this.jassubInstance !== instance) return;
      const video: HTMLVideoElement | undefined = instance._video;
      if (video && video.videoWidth > 0 && video.videoHeight > 0 && typeof instance.manualRender === 'function') {
        await instance.manualRender(
          {
            mediaTime: video.currentTime || 0,
            width: video.videoWidth,
            height: video.videoHeight,
            expectedDisplayTime: performance.now(),
          },
          true
        );
      } else if (instance._lastDemandTime && typeof instance._demandRender === 'function') {
        await instance._demandRender(true);
      } else if (typeof instance.resize === 'function') {
        await instance.resize(true);
      }
    } catch {}
  }

  private applyNativeCuePosition() {
    const track = this.nativeTrackEl?.track;
    if (!track?.cues) return;
    // No valor padrão (5%), preserva o posicionamento original definido pelo autor da legenda VTT (ex.: placas no topo)
    if (this.bottomOffsetPercent === 5 && !this.nativeCuePositionModified) return;
    this.nativeCuePositionModified = this.bottomOffsetPercent !== 5;
    const line = Math.max(50, Math.min(98, 100 - this.bottomOffsetPercent));
    for (const cue of Array.from(track.cues)) {
      const vttCue = cue as VTTCue;
      if ('line' in vttCue) {
        try {
          vttCue.snapToLines = false;
          vttCue.line = line;
        } catch {}
      }
    }
  }

  private applyCssVariables() {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.style.setProperty('--subtitle-font-size', `${this.fontSizePercent}%`);
      document.documentElement.style.setProperty('--subtitle-bottom-offset', `${this.bottomOffsetPercent}%`);
    }
  }

  public initLibass(player: MediaPlayerInstance | null) {
    if (!player || this.isLibassInitialized) return;

    try {
      this.libassRenderer = new LibASSTextRenderer(
        loadCompatibleJassub,
        {
          workerUrl: '/jassub/worker/worker.js',
          legacyWorkerUrl: '/jassub/worker/worker.js',
          availableFonts: { 'liberation sans': '/jassub/default.woff2' },
          fallbackFont: 'liberation sans',
        }
      );

      player.textRenderers.add(this.libassRenderer);
      this.isLibassInitialized = true;
    } catch (err) {
      logger.error('[Legenda] Falha ao iniciar o renderizador de ASS:', err);
    }
  }

  /**
   * Aplica a faixa de legenda adequada de acordo com o formato:
   * - ASS / SSA: Renderizador JASSUB WASM com WebGL
   * - SRT / VTT: Tracks nativas do HTML5 Video
   */
  public async applyTrack(
    video: HTMLVideoElement,
    track: SubtitleTrack | null,
    timeOffset: number = 0,
    signal?: AbortSignal,
    onStatus?: (status: SubtitlePreparationStatus) => void,
  ) {
    const generation = ++this.preparationGeneration;
    this.preparationController?.abort();
    const controller = new AbortController();
    this.preparationController = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const preparationSignal = controller.signal;
    const report = (status: SubtitlePreparationStatus) => {
      if (!preparationSignal.aborted && generation === this.preparationGeneration) onStatus?.(status);
    };
    let stopObservation = () => {};
    try {
      if (!track) {
        this.destroyDirectJassub();
        this.destroyNativeTrack();
        return;
      }
      this.timelineOriginSec = timeOffset;
      if (!track.content) {
        report({ stage: 'queued', updatedAt: Date.now() });
        stopObservation = observeSubtitlePreparation(track.src, report, preparationSignal);
        try {
          if (track.candidate) {
            track.content = (await subtitleResolver.prepareCandidate(track.candidate, preparationSignal)).content;
          } else if (track.src) {
            const response = await apiFetch(track.src, { signal: preparationSignal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            track.content = await response.text();
          }
        } finally {
          stopObservation();
        }
      }
      if (preparationSignal.aborted || generation !== this.preparationGeneration) throw new DOMException('Aborted', 'AbortError');
      const format = requireSubtitleFormat(track.content || '');
      track.type = format === 'ass' || format === 'ssa' ? 'ass' : 'vtt';
      const effectiveOffset = effectiveSubtitleOffset(this.timelineOriginSec, this.subtitleDelaySec);

      if (track.type === 'ass') {
        this.destroyNativeTrack();
        await this.attachDirectJassub(video, track, effectiveOffset, preparationSignal, report);
      } else {
        this.destroyDirectJassub();
        report({ stage: 'initializing_renderer', updatedAt: Date.now() });
        await this.attachNativeTrack(video, track, preparationSignal);
      }
      report({ stage: 'ready', updatedAt: Date.now() });
    } catch (error: any) {
      if (error.name !== 'AbortError') report({ stage: 'failed', updatedAt: Date.now(), errorCode: error.code });
      throw error;
    } finally {
      stopObservation();
      // Promise.all can reject while sibling font transfers are still active.
      controller.abort();
      if (this.preparationController === controller) this.preparationController = null;
      signal?.removeEventListener('abort', abort);
    }
  }

  public async attachDirectJassub(
    video: HTMLVideoElement,
    track: SubtitleTrack,
    timeOffset: number = 0,
    signal?: AbortSignal,
    onStatus?: (status: SubtitlePreparationStatus) => void,
  ) {
    const generation = this.preparationGeneration;
    const assertCurrent = () => {
      if (signal?.aborted || generation !== this.preparationGeneration) throw new DOMException('Aborted', 'AbortError');
    };
    // Destrói instância anterior e limpa canvas residual (zera currentTrack para evitar race com reapplySubtitleAppearance)
    this.currentTrack = null;
    this.appearanceGeneration++;
    if (this.appearanceTimer) {
      clearTimeout(this.appearanceTimer);
      this.appearanceTimer = null;
    }
    if (this.jassubInstance) {
      const previous = this.jassubInstance;
      this.jassubInstance = null;
      this.disposeJassub(previous);
    }
    assertCurrent();

    const oldCanvas = document.querySelector('canvas.JASSUB') as HTMLCanvasElement;
    if (oldCanvas) {
      try {
        oldCanvas.remove();
      } catch {}
    }

    if (track.type !== 'ass' && track.type !== 'ssa') {
      return;
    }

    let instance: any = null;
    try {
      logger.info(`[Legenda] Carregando "${track.label}"…`);
      let subContent = track.content;

      if (!subContent) {
        if (track.candidate) {
          const prepared = await subtitleResolver.prepareCandidate(track.candidate, signal);
          subContent = prepared.content;
        } else if (track.src) {
          const slowNoticeTimer = setTimeout(() => {
            logger.info('[Legenda] Extraindo do arquivo de vídeo no servidor…');
          }, 1500);

          const res = await apiFetch(track.src, { signal });
          clearTimeout(slowNoticeTimer);

          if (!res.ok) {
            let errMessage = `HTTP ${res.status}`;
            let errCode = `HTTP_${res.status}`;
            try {
              const json = await res.json();
              if (json.error) errMessage = json.error;
              if (json.code) errCode = json.code;
            } catch {}
            const err: any = new Error(errMessage);
            err.code = errCode;
            throw err;
          }
          subContent = await res.text();
        }
      }

      if (!subContent || subContent.trim().length === 0) {
        throw new Error(t('Conteúdo da legenda está vazio.'));
      }

      track.content = subContent;

      const JASSUBModule = await import('jassub');
      assertCurrent();
      const JASSUB = (JASSUBModule as any).default || JASSUBModule;

      const session = sessionManager.getSession();
      const embeddedFonts = session?.source?.fonts || [];
      onStatus?.({ stage: 'loading_fonts', updatedAt: Date.now() });

      // Só as fontes que a legenda cita (o MKV costuma trazer ~24, ~46 MB). Se o servidor não souber dizer quais são
      // (rota indisponível, nomes ilegíveis), carrega todas como antes.
      let fontMap: { complete: boolean; fonts: Record<string, string[] | null> } | null = null;
      if (embeddedFonts.length > 1 && session?.source?.mediaUrl) {
        try {
          const res = await apiFetch(
            `/api/fontmap?url=${encodeURIComponent(session.source.mediaUrl)}&fingerprint=${encodeURIComponent(session.source.mediaFingerprint || '')}`,
            { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) }
          );
          if (res.ok) fontMap = await res.json();
        } catch {
          // sem o mapa: carrega todas
        }
      }
      assertCurrent();
      const { urls: embeddedFontUrls, skipped } = selectFontsToLoad(embeddedFonts, fontMap, collectAssFontNames(subContent));

      if (embeddedFontUrls.length > 0) {
        logger.info(
          `[Legenda] ${embeddedFontUrls.length} ${embeddedFontUrls.length === 1 ? 'fonte' : 'fontes'} do arquivo carregada(s)` +
            (skipped > 0 ? ` (${skipped} que a legenda não usa ficaram de fora)` : '')
        );
      }

      const fontSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000);
      const fonts = await Promise.all([
        '/fonts/trebuc.ttf',
        '/fonts/trebucbd.ttf',
        '/fonts/trebucbi.ttf',
        '/fonts/trebucit.ttf',
        '/jassub/default.woff2',
        ...embeddedFontUrls,
      ].map(async url => {
        const response = await apiFetch(url, { signal: fontSignal });
        if (!response.ok) throw Object.assign(new Error(t('Falha ao carregar fontes da legenda.')), { code: 'SUBTITLE_FONT_FAILED' });
        return new Uint8Array(await response.arrayBuffer());
      }));
      assertCurrent();

      const appliedFontSize = this.fontSizePercent;
      const appliedBottomOffset = this.bottomOffsetPercent;
      const styledAssContent = transformAssStyle(subContent, appliedFontSize, appliedBottomOffset);

      const opts: any = {
        video,
        subContent: styledAssContent,
        debug: false,
        wasmUrl: '/jassub/wasm/jassub-worker.wasm',
        modernWasmUrl: '/jassub/wasm/jassub-worker-modern.wasm',
        defaultFont: 'Trebuchet MS',
        fonts,
        timeOffset: timeOffset || 0,
        asyncRender: true,
      };

      instance = new JASSUB(opts);
      this.jassubInstance = instance;
      onStatus?.({ stage: 'initializing_renderer', updatedAt: Date.now() });
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
        const aborted = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Tempo limite de ${LIBASS_INIT_TIMEOUT_MS / 1000}s esgotado ao inicializar LibASS WASM.`)); }, LIBASS_INIT_TIMEOUT_MS);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
        Promise.resolve(instance.ready).then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
      });
      assertCurrent();
      instance.timeOffset = effectiveSubtitleOffset(this.timelineOriginSec, this.subtitleDelaySec);

      this.currentTrack = track;
      if (this.fontSizePercent !== appliedFontSize || this.bottomOffsetPercent !== appliedBottomOffset) {
        this.reapplySubtitleAppearance();
      }

      // Posiciona o canvas perfeitamente sobre a camada de vídeo com fundo 100% transparente
      const setupCanvas = () => {
        if (signal?.aborted || generation !== this.preparationGeneration || this.jassubInstance !== instance) return;
        const canvas =
          (instance?._canvas as HTMLCanvasElement) ||
          (video.parentElement?.querySelector('canvas.JASSUB') as HTMLCanvasElement) ||
          (document.querySelector('canvas.JASSUB') as HTMLCanvasElement);

        if (canvas) {
          canvas.style.position = 'absolute';
          canvas.style.top = '0';
          canvas.style.left = '0';
          canvas.style.width = '100%';
          canvas.style.height = '100%';
          canvas.style.pointerEvents = 'none';
          canvas.style.zIndex = '20';
          canvas.style.setProperty('background', 'transparent', 'important');
          canvas.style.setProperty('background-color', 'transparent', 'important');
          canvas.style.objectFit = 'contain';
          canvas.style.display = 'block';
        }
      };

      setupCanvas();

      logger.info(`[Legenda] Exibindo "${track.label}" (ASS)`);
    } catch (err: any) {
      if (instance && this.jassubInstance === instance) {
        this.jassubInstance = null;
        this.disposeJassub(instance);
      }
      if (err.name === 'AbortError') throw err;
      logger.error('[Legenda] Falha ao ativar o renderizador de ASS:', err);
      throw err;
    }
  }

  public async attachNativeTrack(video: HTMLVideoElement, track: SubtitleTrack, signal?: AbortSignal) {
    this.destroyNativeTrack();
    const generation = this.preparationGeneration;
    let ownedTrack: HTMLTrackElement | null = null;
    try {
      let content = track.content;
      if (!content) {
        if (track.candidate) {
          const prepared = await subtitleResolver.prepareCandidate(track.candidate, signal);
          content = prepared.content;
        } else if (track.src) {
          const res = await apiFetch(track.src, { signal });
          if (!res.ok) {
            let errMessage = `HTTP ${res.status}`;
            let errCode = `HTTP_${res.status}`;
            try {
              const json = await res.json();
              if (json.error) errMessage = json.error;
              if (json.code) errCode = json.code;
            } catch {}
            const err: any = new Error(errMessage);
            err.code = errCode;
            throw err;
          }
          content = await res.text();
        }
      }

      if (!content) return;
      if (signal?.aborted || generation !== this.preparationGeneration) throw new DOMException('Aborted', 'AbortError');
      track.content = content;

      const vttContent = content.trim().startsWith('WEBVTT') ? content : srtToVtt(content);
      const blob = new Blob([vttContent], { type: 'text/vtt' });
      const blobUrl = URL.createObjectURL(blob);
      this.nativeBlobUrl = blobUrl;

      const trackEl = document.createElement('track');
      ownedTrack = trackEl;
      trackEl.kind = 'subtitles';
      trackEl.label = track.label;
      trackEl.srclang = track.language || 'pt';
      trackEl.src = blobUrl;
      trackEl.default = true;

      this.nativeTrackEl = trackEl;

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          trackEl.removeEventListener('load', loaded);
          trackEl.removeEventListener('error', failed);
          signal?.removeEventListener('abort', aborted);
          if (this.cancelNativeLoad === aborted) this.cancelNativeLoad = null;
        };
        const loaded = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('Falha ao carregar a legenda no navegador.')); };
        const aborted = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(failed, 15_000);
        this.cancelNativeLoad = aborted;
        trackEl.addEventListener('load', loaded, { once: true });
        trackEl.addEventListener('error', failed, { once: true });
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
        else {
          video.appendChild(trackEl);
          trackEl.track.mode = 'hidden';
        }
      });
      if (signal?.aborted || generation !== this.preparationGeneration || this.nativeTrackEl !== trackEl) throw new DOMException('Aborted', 'AbortError');
      this.currentTrack = track;
      if (trackEl.track) {
        this.nativeOriginalCues = Array.from(trackEl.track.cues || []).map(cue => ({ cue, start: cue.startTime, end: cue.endTime }));
        this.applySubtitleOffset();
        this.applyNativeCuePosition();
        trackEl.track.mode = 'showing';
      }

      logger.info(`[Legenda] Exibindo "${track.label}" (VTT)`);
    } catch (err: any) {
      if (ownedTrack && this.nativeTrackEl === ownedTrack) this.destroyNativeTrack();
      if (err.name === 'AbortError') throw err;
      logger.error('[Legenda] Falha ao carregar a legenda VTT:', err);
      throw err;
    }
  }

  public destroyNativeTrack() {
    this.cancelNativeLoad?.();
    this.nativeOriginalCues = [];
    this.nativeCuePositionModified = false;
    if (!this.jassubInstance) this.currentTrack = null;
    if (this.nativeTrackEl) {
      try {
        if (this.nativeTrackEl.track) {
          this.nativeTrackEl.track.mode = 'disabled';
        }
        this.nativeTrackEl.remove();
      } catch {}
      this.nativeTrackEl = null;
    }
    if (this.nativeBlobUrl) {
      try {
        URL.revokeObjectURL(this.nativeBlobUrl);
      } catch {}
      this.nativeBlobUrl = null;
    }
  }

  public resize() {
    if (this.jassubInstance && typeof this.jassubInstance.resize === 'function') {
      try {
        this.jassubInstance.resize(true);
      } catch {}
    }
    const canvas = document.querySelector('canvas.JASSUB') as HTMLCanvasElement;
    if (canvas) {
      canvas.style.position = 'absolute';
      canvas.style.top = '0';
      canvas.style.left = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.pointerEvents = 'none';
      canvas.style.zIndex = '20';
      canvas.style.setProperty('background', 'transparent', 'important');
      canvas.style.setProperty('background-color', 'transparent', 'important');
      canvas.style.objectFit = 'contain';
      canvas.style.display = 'block';
    }
  }

  public setTimeOffset(offset: number) {
    this.timelineOriginSec = offset;
    this.applySubtitleOffset();
  }

  private applySubtitleOffset() {
    const offset = effectiveSubtitleOffset(this.timelineOriginSec, this.subtitleDelaySec);
    if (this.jassubInstance) {
      try {
        this.jassubInstance.timeOffset = offset;
        void this.forceJassubRepaint(this.jassubInstance);
      } catch {}
    }
    const track = this.nativeTrackEl?.track;
    if (track) {
      const present = new Set(Array.from(track.cues || []));
      for (const { cue, start, end } of this.nativeOriginalCues) {
        const shifted = shiftCueWindow(start, end, offset);
        if (!shifted) {
          if (present.has(cue)) track.removeCue(cue);
        } else {
          // Reuse each browser cue to preserve its text, ID and layout settings.
          cue.startTime = shifted.start;
          cue.endTime = shifted.end;
          if (!present.has(cue)) track.addCue(cue);
        }
      }
    }
  }

  public destroyDirectJassub() {
    this.appearanceGeneration++;
    if (this.appearanceTimer) {
      clearTimeout(this.appearanceTimer);
      this.appearanceTimer = null;
    }
    if (!this.nativeTrackEl) this.currentTrack = null;
    if (this.jassubInstance) {
      this.disposeJassub(this.jassubInstance);
      this.jassubInstance = null;
    }
    const canvas = document.querySelector('canvas.JASSUB') as HTMLCanvasElement;
    if (canvas) {
      try {
        canvas.style.display = 'none';
        canvas.remove();
      } catch {}
    }
    this.currentTrack = null;
  }

  private disposeJassub(instance: any) {
    try { void Promise.resolve(instance.destroy()).catch(() => {}); } catch {}
    // This JASSUB version waits for ready inside destroy(). A cancelled WASM
    // initialization must release its worker without delaying the next track.
    try { instance._worker?.terminate(); } catch {}
  }

  public getCurrentTrack(): SubtitleTrack | null {
    return this.currentTrack;
  }
}

export const subtitleManager = new SubtitleManager();

