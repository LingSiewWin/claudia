import type { Limits } from '../lib/contract';
import { money } from '../lib/format';

/**
 * The authority boundary, drawn from the mandate itself: AUTONOMOUS up to the autonomous limit, CFO APPROVAL up to
 * the hard cap, FORBIDDEN above it. The scale ends at 1.25 x hard cap so the forbidden zone is always visible.
 */
export function BoundaryRail({
  limits,
  amount,
  placed,
  revoked = false,
  full = false,
}: {
  limits: Limits;
  amount: string | null;
  placed: boolean;
  revoked?: boolean;
  full?: boolean;
}) {
  const auto = BigInt(limits.autonomous_limit);
  const cap = BigInt(limits.hard_cap);
  const end = (cap * 5n) / 4n;
  const pct = (v: bigint) => Number(((v > end ? end : v) * 10_000n) / end) / 100;
  const usd = (v: bigint) => money(v, limits.decimals, true);
  const zones = [
    { key: 'autonomous', name: 'AUTONOMOUS', bounds: `${usd(0n)}–${usd(auto)}`, width: pct(auto), tone: 'bg-permit/35', swatch: 'bg-permit/70' },
    { key: 'cfo', name: 'CFO APPROVAL', bounds: `${usd(auto)}–${usd(cap)}`, width: pct(cap) - pct(auto), tone: 'bg-cosign/40', swatch: 'bg-cosign/70' },
    { key: 'forbidden', name: 'FORBIDDEN', bounds: `above ${usd(cap)}`, width: 100 - pct(cap), tone: 'forbid-hatch', swatch: 'bg-forbid/70' },
  ];
  const value = amount === null ? null : BigInt(amount);
  const active = value === null || !placed ? -1 : value <= auto ? 0 : value <= cap ? 1 : 2;
  return (
    <figure className="w-full" aria-label="Authority boundary">
      <div className={`relative flex ${full ? 'h-16' : 'h-2.5'} w-full overflow-hidden rounded-sm`}>
        {revoked ? (
          <div className="forbid-hatch flex flex-1 items-center px-3 text-sm font-semibold text-fg">
            {full ? 'Revoked. Nobody can spend under this mandate.' : null}
          </div>
        ) : (
          zones.map((z) => (
            <div
              key={z.key}
              data-testid={full ? `zone-${z.key}` : undefined}
              className={`${z.tone} flex flex-col justify-center px-3 text-fg`}
              style={{ width: `${z.width}%` }}
            >
              {full ? (
                <>
                  <span className="text-sm font-extrabold tracking-wide">{z.name}</span>
                  <span className="text-sm">{z.bounds}</span>
                </>
              ) : null}
            </div>
          ))
        )}
        {value !== null && !revoked ? (
          <span
            data-testid="rail-marker"
            className="rail-marker absolute top-0 h-full w-[3px] -translate-x-1/2 bg-fg"
            style={{ left: `${placed ? pct(value) : 0}%`, opacity: placed ? 1 : 0 }}
          />
        ) : null}
      </div>
      {full || revoked ? null : (
        <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] font-semibold tracking-wide">
          {zones.map((z, i) => (
            <span key={z.key} data-testid={`zone-${z.key}`} className={i === active ? 'text-fg' : 'text-muted'}>
              <span aria-hidden className={`mr-1.5 inline-block size-2 ${z.swatch}`} />
              {z.name} <span className="font-normal">{z.bounds}</span>
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
