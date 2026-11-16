import { failTransform } from './transform-safety';

export function validTimeZone(zone: unknown): boolean {
  if (typeof zone !== 'string' || !zone || /^[+-]/u.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const NUMERIC = /^-?\d+(\.\d+)?$/u;

/** No parseInt/Number coercion of booleans, hex, exponents, empty text or non-finite values. */
export function textToNumber(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !NUMERIC.test(value.trim())))
    return failTransform('transform.invalid_output');
  const n = Number(value);
  if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n)))
    return failTransform('transform.invalid_output');
  return n;
}

/** YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss[.SSS][Z|±HH:mm]. Missing offset means UTC. */
function isoMillis(value: unknown): number {
  if (typeof value !== 'string') return failTransform('transform.invalid_output');
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?)?$/u.exec(
      value
    );
  if (!match) return failTransform('transform.invalid_output');
  const [, y, m, d, h = '0', min = '0', sec = '0', fraction = '', zone = 'Z'] = match;
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  const hour = Number(h),
    minute = Number(min),
    second = Number(sec);
  // setUTCFullYear avoids Date.UTC's special interpretation of years 00–99.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number(fraction.padEnd(3, '0')));
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return failTransform('transform.invalid_output');
  let offset = 0;
  if (zone !== 'Z') {
    const zh = Number(zone.slice(1, 3)),
      zm = Number(zone.slice(4, 6));
    if (zh > 23 || zm > 59) return failTransform('transform.invalid_output');
    offset = (zh * 60 + zm) * (zone[0] === '+' ? 1 : -1);
  }
  return date.getTime() - offset * 60_000;
}

/** Convert decimal seconds without binary multiplication or rounding sub-millisecond input. */
function epochMillis(value: unknown, milliseconds: boolean): number {
  // Validate the same numeric syntax and finite/safe integer constraints as text_to_number.
  textToNumber(value);
  const text = typeof value === 'string' ? value.trim() : String(value);
  // Numeric inputs may stringify in exponent notation. Expand that notation as decimal digits.
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(text);
  if (!match) return failTransform('transform.invalid_output');
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  const digits = whole + fraction;
  const shift = Number(exponent) + (milliseconds ? 0 : 3) - fraction.length;
  const magnitude = BigInt(digits);
  const result =
    shift >= 0
      ? magnitude * 10n ** BigInt(shift)
      : (() => {
          const divisor = 10n ** BigInt(-shift);
          if (magnitude % divisor !== 0n) return failTransform('transform.invalid_output');
          return magnitude / divisor;
        })();
  const signed = sign === '-' ? -result : result;
  const ms = Number(signed);
  if (!Number.isSafeInteger(ms)) return failTransform('transform.invalid_output');
  return ms;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function dateFormat(value: unknown, p: Record<string, unknown>): unknown {
  const numeric =
    typeof value === 'number' || (typeof value === 'string' && NUMERIC.test(value.trim()));
  let ms: number;
  if (p.from === 'unix_s' || p.from === 'unix_ms' || (p.from === 'auto' && numeric)) {
    const n = textToNumber(value);
    ms = epochMillis(value, p.from === 'unix_ms' || (p.from === 'auto' && Math.abs(n) >= 1e11));
  } else {
    ms = isoMillis(value);
  }
  const date = new Date(ms);
  // Keep all output formats in the same explicit ISO four-digit year domain.
  if (
    !Number.isFinite(ms) ||
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() < 1 ||
    date.getUTCFullYear() > 9999
  )
    return failTransform('transform.invalid_output');
  if (p.to === 'unix_s') return Math.floor(ms / 1000);
  if (p.to === 'unix_ms') return ms;
  const zone = typeof p.timeZone === 'string' ? p.timeZone : 'UTC';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      era: 'short',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  const year = Number(parts.year);
  if (parts.era !== 'AD' || year < 1 || year > 9999)
    return failTransform('transform.invalid_output');
  const day = `${String(year).padStart(4, '0')}-${parts.month}-${parts.day}`;
  if (p.to === 'date') return day;
  const wall = new Date(0);
  wall.setUTCFullYear(year, Number(parts.month) - 1, Number(parts.day));
  wall.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), 0);
  const offsetMillis = wall.getTime() - Math.floor(ms / 1000) * 1000;
  // Historical second-based offsets cannot be represented by the console's ±HH:mm format.
  if (offsetMillis % 60000 !== 0) return failTransform('transform.invalid_output');
  const minutes = offsetMillis / 60000;
  const offset =
    minutes === 0
      ? 'Z'
      : `${minutes > 0 ? '+' : '-'}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
  // Console ISO output has second precision; Unix milliseconds retain the fraction.
  return `${day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}
