import type { ScreenQuality } from '../../types/screen';
import type { AudioDataLike, Capture, FrameReader, PublisherBrowser, VideoFrameLike } from './publisher';
import { captureConstraints } from './quality';

/** `MediaStreamTrackProcessor` ainda não está nos tipos do DOM. */
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream };

function readerOf<T>(track: MediaStreamTrack): FrameReader<T> {
  const Processor = (globalThis as unknown as { MediaStreamTrackProcessor: TrackProcessorCtor }).MediaStreamTrackProcessor;
  return new Processor({ track }).readable.getReader() as unknown as FrameReader<T>;
}

/** Implementação real de `PublisherBrowser` (Chromium de desktop): captura, WebCodecs e wake lock. */
export function browserPublisher(): PublisherBrowser {
  return {
    async capture(q: ScreenQuality): Promise<Capture> {
      const stream = await navigator.mediaDevices.getDisplayMedia(captureConstraints(q));
      const vtrack = stream.getVideoTracks()[0];
      const atrack = stream.getAudioTracks()[0] ?? null;
      if (!vtrack) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('Nenhuma tela foi escolhida.');
      }
      // Tela em movimento: o codificador prefere manter o fps a manter a nitidez
      vtrack.contentHint = 'motion';

      // O áudio vira 48 kHz estéreo explícito antes do codificador
      let ac: AudioContext | null = null;
      let audio: FrameReader<AudioDataLike> | null = null;
      if (atrack) {
        ac = new AudioContext({ sampleRate: 48000 });
        const source = ac.createMediaStreamSource(new MediaStream([atrack]));
        const dest = ac.createMediaStreamDestination();
        dest.channelCount = 2;
        dest.channelCountMode = 'explicit';
        dest.channelInterpretation = 'speakers';
        source.connect(dest);
        audio = readerOf<AudioDataLike>(dest.stream.getAudioTracks()[0]);
      }

      let wake: { release(): Promise<void> } | null = null;
      try {
        wake = (await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen')) ?? null;
      } catch {}

      return {
        video: readerOf<VideoFrameLike>(vtrack),
        audio,
        // A mesma faixa de vídeo pode alimentar o codificador e uma prévia ao mesmo tempo
        preview: new MediaStream([vtrack]),
        onEnded: (cb) => vtrack.addEventListener('ended', cb, { once: true }),
        stop() {
          stream.getTracks().forEach((t) => t.stop());
          void ac?.close().catch(() => {});
          void wake?.release().catch(() => {});
        },
      };
    },

    createVideoEncoder(h) {
      const encoder = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          h.output({ key: chunk.type === 'key', data, timestampUs: chunk.timestamp });
        },
        error: h.error,
      });
      return {
        async configure(cfg) {
          // Sem codificador de hardware para esta configuração, deixa o navegador escolher
          const support = await VideoEncoder.isConfigSupported(cfg);
          encoder.configure(support.supported ? cfg : { ...cfg, hardwareAcceleration: 'no-preference' });
        },
        encode: (frame, opts) => encoder.encode(frame as unknown as VideoFrame, opts),
        get encodeQueueSize() {
          return encoder.encodeQueueSize;
        },
        close: () => encoder.close(),
      };
    },

    createAudioEncoder(h) {
      const encoder = new AudioEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          h.output({ data, timestampUs: chunk.timestamp });
        },
        error: h.error,
      });
      return {
        configure: (cfg) => encoder.configure(cfg),
        encode: (data) => encoder.encode(data as unknown as AudioData),
        close: () => encoder.close(),
      };
    },
  };
}
