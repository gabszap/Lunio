const hrtime = typeof process !== 'undefined' && !!process.hrtime;
const maxTick = 65535;
const resolution = 10;
const timeDiff = hrtime ? 1e9 / resolution : 1e3 / resolution;
const now = hrtime
  ? () => {
      const [seconds, nanoseconds] = process.hrtime();
      return seconds * 1e9 + nanoseconds;
    }
  : () => performance.now();

function getTick(start: number) {
  return ((now() - start) / timeDiff) & maxTick;
}

export default function throughput(seconds?: number) {
  const start = now();
  const size = resolution * (seconds || 5);
  const buffer = new Float64Array(size);
  let pointer = 1;
  let last = (getTick(start) - 1) & maxTick;

  return function (delta?: number) {
    const tick = getTick(start);
    let dist = (tick - last) & maxTick;
    if (dist > size) dist = size;
    last = tick;

    while (dist--) {
      if (pointer === size) pointer = 0;
      buffer[pointer] = buffer[pointer === 0 ? size - 1 : pointer - 1];
      pointer++;
    }

    if (delta) buffer[pointer - 1] += delta;

    let sum = 0;
    let i = size;
    while (i--) sum += buffer[i];
    return sum / (seconds || 5);
  };
}
