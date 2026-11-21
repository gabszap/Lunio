import React from 'react';
import { Tv } from 'lucide-react';

const icons: Record<string, string> = {
  'Apple TV': 'apple-tv', Crunchyroll: 'crunchyroll', Amazon: 'amazon', HiDive: 'hidive', Hulu: 'hulu', YouTube: 'youtube',
  Netflix: 'netflix', 'Disney+': 'disney-plus', OceanVeil: 'oceanveil', BiliBili: 'bilibili', 'BiliBili TV': 'bilibili',
};
export function StreamingIcon({ platform }: { platform: string }) {
  const file = icons[platform];
  return file ? <img src={`/streaming-icons/${file}.svg`} alt="" width={18} height={18} className="w-[18px] h-[18px] object-contain shrink-0" style={file === 'apple-tv' ? { filter: 'brightness(0) invert(1)' } : undefined} /> : <Tv size={18} aria-hidden="true" className="shrink-0" />;
}
