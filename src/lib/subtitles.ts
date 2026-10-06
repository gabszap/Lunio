import { LibASSTextRenderer, MediaPlayerInstance } from '@vidstack/react';
import {
  SubtitleTrack,
  SubtitleCandidate,
  SubtitlePreferences,
  ResolvedMediaRef,
  SubtitleFormat,
} from '../types/media';
import { logger } from './logger';
import { srtToVtt } from './media';
import { sessionManager } from './session';

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
            id: `embedded_${media.mediaUrl}_${st.index}`,
            language: lang,
            format,
            source: 'embedded',
            url: `/api/subtitle?url=${encodeURIComponent(media.mediaUrl)}&track=${st.index}`,
            trackId: st.index,
            confidence: 0,
            forced: !!st.isForced,
            title: st.label || `Legenda #${st.index}`,
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
          title: es.title || `Legenda Externa (${es.language})`,
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
        if (cand.format === 'ass' || cand.format === 'ssa') {
          score += 300;
        } else if (cand.format === 'srt' || cand.format === 'vtt') {
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
      return candidate;
    }

    if (this.candidateCache.has(candidate.id)) {
      const cached = this.candidateCache.get(candidate.id)!;
      if (cached.content) {
        candidate.content = cached.content;
        candidate.availability = 'ready';
        return candidate;
      }
    }

    this.cancelActivePreparation();

    const controller = new AbortController();
    this.activeExtractionAbort = controller;

    if (signal) {
      signal.addEventListener('abort', () => controller.abort());
    }

    candidate.availability = 'pending';

    try {
      if (!candidate.url) {
        throw new Error('Candidate não possui URL válida.');
      }

      const res = await fetch(candidate.url, {
        signal: controller.signal,
      });

      if (!res.ok) {
        let errMessage = `HTTP ${res.status} ao carregar legenda.`;
        let errCode = 'EXTRACTION_FAILED';
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
      candidate.content = content;
      candidate.availability = 'ready';
      this.candidateCache.set(candidate.id, candidate);
      return candidate;
    } catch (err: any) {
      candidate.availability = 'known';
      if (err.name === 'AbortError') {
        logger.info(`[Legenda] Preparação de "${candidate.title}" cancelada`);
      }
      throw err;
    } finally {
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
  private libassRenderer: LibASSTextRenderer | null = null;
  private jassubInstance: any = null;
  private nativeTrackEl: HTMLTrackElement | null = null;
  private nativeBlobUrl: string | null = null;
  private currentTrack: SubtitleTrack | null = null;
  private isLibassInitialized = false;
  private subtitleDelaySec = 0; // -10.0s to +10.0s
  private fontSizePercent = 100; // 50% to 250%
  private bottomOffsetPercent = 5; // 0% to 30%

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
    this.setTimeOffset(clamped);
    logger.setting('Sincronia da legenda', `${Math.round(clamped * 1000)} ms`);
  }

  public setFontSize(percent: number) {
    const clamped = Math.max(50, Math.min(250, percent));
    this.fontSizePercent = clamped;
    if (typeof window !== 'undefined') {
      localStorage.setItem('vidstack_player_subtitle_font_size', clamped.toString());
    }
    this.applyCssVariables();
    logger.setting('Tamanho da legenda', `${clamped}%`);
  }

  public setBottomOffset(percent: number) {
    const clamped = Math.max(0, Math.min(30, percent));
    this.bottomOffsetPercent = clamped;
    if (typeof window !== 'undefined') {
      localStorage.setItem('vidstack_player_subtitle_bottom_offset', clamped.toString());
    }
    this.applyCssVariables();
    logger.setting('Posição da legenda', `${clamped}%`);
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
    signal?: AbortSignal
  ) {
    if (!track) {
      this.destroyDirectJassub();
      this.destroyNativeTrack();
      return;
    }

    const effectiveOffset = timeOffset !== 0 ? timeOffset : this.subtitleDelaySec;

    if (track.type === 'ass' || track.type === 'ssa') {
      this.destroyNativeTrack();
      await this.attachDirectJassub(video, track, effectiveOffset, signal);
    } else {
      this.destroyDirectJassub();
      await this.attachNativeTrack(video, track, signal);
    }
  }

  public async attachDirectJassub(
    video: HTMLVideoElement,
    track: SubtitleTrack,
    timeOffset: number = 0,
    signal?: AbortSignal
  ) {
    // Destrói instância anterior e limpa canvas residual
    if (this.jassubInstance) {
      try {
        await this.jassubInstance.destroy();
      } catch {}
      this.jassubInstance = null;
    }

    const oldCanvas = document.querySelector('canvas.JASSUB') as HTMLCanvasElement;
    if (oldCanvas) {
      try {
        oldCanvas.remove();
      } catch {}
    }

    if (track.type !== 'ass' && track.type !== 'ssa') {
      return;
    }

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

          const res = await fetch(track.src, { signal });
          clearTimeout(slowNoticeTimer);

          if (!res.ok) {
            let errMessage = `HTTP ${res.status}`;
            let errCode = 'EXTRACTION_FAILED';
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
        throw new Error('Conteúdo da legenda está vazio.');
      }

      track.content = subContent;

      const JASSUBModule = await import('jassub');
      const JASSUB = (JASSUBModule as any).default || JASSUBModule;

      const session = sessionManager.getSession();
      const embeddedFonts = session?.source?.fonts || [];
      const embeddedFontUrls = embeddedFonts
        .map((f) => f.url)
        .filter(Boolean) as string[];

      if (embeddedFontUrls.length > 0) {
        logger.info(`[Legenda] ${embeddedFontUrls.length} ${embeddedFontUrls.length === 1 ? 'fonte' : 'fontes'} do arquivo carregada(s)`);
      }

      const opts: any = {
        video,
        subContent,
        debug: false,
        wasmUrl: '/jassub/wasm/jassub-worker.wasm',
        modernWasmUrl: '/jassub/wasm/jassub-worker-modern.wasm',
        defaultFont: 'Trebuchet MS',
        fonts: [
          '/fonts/trebuc.ttf',
          '/fonts/trebucbd.ttf',
          '/fonts/trebucbi.ttf',
          '/fonts/trebucit.ttf',
          '/jassub/default.woff2',
          ...embeddedFontUrls,
        ],
        timeOffset: timeOffset || 0,
        asyncRender: true,
      };

      this.jassubInstance = new JASSUB(opts);

      await Promise.race([
        this.jassubInstance.ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Tempo limite de 25s esgotado ao inicializar LibASS WASM.')), 25000)
        ),
      ]);

      this.currentTrack = track;

      // Posiciona o canvas perfeitamente sobre a camada de vídeo com fundo 100% transparente
      const setupCanvas = () => {
        const canvas =
          (this.jassubInstance?._canvas as HTMLCanvasElement) ||
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
      setTimeout(setupCanvas, 80);
      setTimeout(setupCanvas, 300);

      logger.info(`[Legenda] Exibindo "${track.label}" (ASS)`);
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      logger.error('[Legenda] Falha ao ativar o renderizador de ASS:', err);
      throw err;
    }
  }

  public async attachNativeTrack(video: HTMLVideoElement, track: SubtitleTrack, signal?: AbortSignal) {
    this.destroyNativeTrack();

    try {
      let content = track.content;
      if (!content) {
        if (track.candidate) {
          const prepared = await subtitleResolver.prepareCandidate(track.candidate, signal);
          content = prepared.content;
        } else if (track.src) {
          const res = await fetch(track.src, { signal });
          if (!res.ok) {
            let errMessage = `HTTP ${res.status}`;
            let errCode = 'EXTRACTION_FAILED';
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
      track.content = content;

      const vttContent = content.trim().startsWith('WEBVTT') ? content : srtToVtt(content);
      const blob = new Blob([vttContent], { type: 'text/vtt' });
      const blobUrl = URL.createObjectURL(blob);
      this.nativeBlobUrl = blobUrl;

      const trackEl = document.createElement('track');
      trackEl.kind = 'subtitles';
      trackEl.label = track.label;
      trackEl.srclang = track.language || 'pt';
      trackEl.src = blobUrl;
      trackEl.default = true;

      video.appendChild(trackEl);
      this.nativeTrackEl = trackEl;
      this.currentTrack = track;

      if (trackEl.track) {
        trackEl.track.mode = 'showing';
      }

      logger.info(`[Legenda] Exibindo "${track.label}" (VTT)`);
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      logger.error('[Legenda] Falha ao carregar a legenda VTT:', err);
      throw err;
    }
  }

  public destroyNativeTrack() {
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
    if (this.jassubInstance) {
      try {
        this.jassubInstance.timeOffset = offset;
        this.jassubInstance.resize(true);
      } catch {}
    }
  }

  public destroyDirectJassub() {
    if (this.jassubInstance) {
      try {
        this.jassubInstance.destroy();
      } catch {}
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
    subtitleResolver.cancelActivePreparation();
  }

  public getCurrentTrack(): SubtitleTrack | null {
    return this.currentTrack;
  }
}

export const subtitleManager = new SubtitleManager();

