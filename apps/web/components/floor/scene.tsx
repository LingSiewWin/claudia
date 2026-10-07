import type { Crate, Floor, Station } from './model';

/*
 * The authority floor: a 2.5D isometric scene in plain SVG. Every shape is a box with three faces projected by `P`;
 * crates are translated along precomputed screen vectors (CSS transition in floor.css), so a crate only ever moves
 * when the reducer moved its card. No WebGL, no timers.
 */
const S = 36;
const C = Math.cos(Math.PI / 6);
const OX = 190;
const OY = 190;
export const VIEW = { w: 1120, h: 660 };

type Pt = [number, number, number?];
const P = (x: number, y: number, z: number = 0): [number, number] => [OX + (x - y) * C * S, OY + ((x + y) * S) / 2 - z * S];
const pts = (list: Pt[]) => list.map(([x, y, z]) => P(x, y, z ?? 0).join(',')).join(' ');
/** Screen vector for a crate drawn at the origin, moved to floor point (x, y, z). */
const shift = (x: number, y: number, z = 0) => `translate(${((x - y) * C * S).toFixed(1)}px, ${(((x + y) * S) / 2 - z * S).toFixed(1)}px)`;

function Box({ x, y, z = 0, w, d, h, className = '' }: { x: number; y: number; z?: number; w: number; d: number; h: number; className?: string }) {
  return (
    <g className={`floor-box ${className}`}>
      <polygon className="f-left" points={pts([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]])} />
      <polygon className="f-right" points={pts([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]])} />
      <polygon className="f-top" points={pts([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]])} />
    </g>
  );
}

function Shadow({ x, y, w, d }: { x: number; y: number; w: number; d: number }) {
  return <polygon className="floor-shadow" points={pts([[x - 0.2, y - 0.1, 0], [x + w + 0.4, y - 0.1, 0], [x + w + 0.7, y + d + 0.3, 0], [x + 0.1, y + d + 0.3, 0]])} />;
}

/** Station i stands at (3i, -i/2): a gentle diagonal from top-left to bottom-right, leaving the corners for the overlays. */
const AT: Record<Exclude<Station, 'sink'>, [number, number]> = {
  agent: [0, 0],
  gate: [3, -0.5],
  tower: [6, -1],
  escrow: [9, -1.5],
  desk: [12, -2],
  vault: [15, -2.5],
  ledger: [18, -3],
};
const SINK: [number, number] = [9.2, 1.9];
const LABEL: Record<Station, string> = {
  agent: 'Agent',
  gate: 'Authority Engine',
  tower: 'Chainlink CRE',
  escrow: 'Bond escrow',
  desk: 'Human',
  vault: 'Treasury vault',
  ledger: 'Receipts',
  sink: 'Sink',
};

/** Where a crate rests at each station: in front of the building. Returned crates pile beside the agent. */
function dock(c: Crate): [number, number] {
  if (c.station === 'sink') return [SINK[0] + 0.6, SINK[1] + 0.6];
  const [x, y] = AT[c.station];
  if (c.station === 'agent') return c.bounced ? [x - 1.3, y + 2.6] : [x + 0.6, y + 2.6];
  return [x + 0.6, y + 2.6];
}

function Label({ station }: { station: Station }) {
  const [x, y] = station === 'sink' ? SINK : AT[station];
  const [px, py] = P(x + 1.1, y + 2.3 + (station === 'sink' ? 0.3 : 0.8));
  return (
    <text className="floor-label" x={px} y={py + 14} textAnchor="middle">
      {LABEL[station].toUpperCase()}
    </text>
  );
}

export function Scene({ floor, selected, onSelect }: { floor: Floor; selected: string | null; onSelect?: (id: string) => void }) {
  const st = floor.stations;
  const piles = new Map<string, number>();
  const crates = floor.crates.map((c) => {
    const key = `${c.station}:${c.bounced}`;
    const k = piles.get(key) ?? 0;
    piles.set(key, k + 1);
    const [x, y] = dock(c);
    return { c, x, y, z: k * 0.82 };
  });
  const [ax, ay] = AT.agent;
  const [gx, gy] = AT.gate;
  const [tx, ty] = AT.tower;
  const [ex, ey] = AT.escrow;
  const [dx, dy] = AT.desk;
  const [vx, vy] = AT.vault;
  const [lx, ly] = AT.ledger;
  const towerTop = P(tx + 0.7, ty + 0.7, 4.4);
  const dockT = dock({ station: 'tower', bounced: false } as Crate);
  const beam = [towerTop.join(','), P(dockT[0] - 0.4, dockT[1] + 1.4).join(','), P(dockT[0] + 1.5, dockT[1] + 1.4).join(','), P(dockT[0] + 1.5, dockT[1] - 0.6).join(','), P(dockT[0] - 0.4, dockT[1] - 0.6).join(',')].join(' ');
  const deskCard = P(dx + 1.1, dy + 1.1, 2.4);

  return (
    <svg className="floor-svg" viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} role="img" aria-label="Isometric authority floor: agent, authority engine, Chainlink CRE, bond escrow, human desk, treasury vault, receipts">
      <defs>
        <filter id="floor-blur" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <linearGradient id="floor-beam-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--beam)" stopOpacity="0.85" />
          <stop offset="1" stopColor="var(--beam)" stopOpacity="0.05" />
        </linearGradient>
        <radialGradient id="floor-glow">
          <stop offset="0" stopColor="var(--permit)" stopOpacity="0.55" />
          <stop offset="1" stopColor="var(--permit)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* slab */}
      <polygon className="floor-slab-side" points={pts([[-2.2, 4.6, -0.35], [21, 4.6, -0.35], [21, 4.6, 0], [-2.2, 4.6, 0]])} />
      <polygon className="floor-slab-side r" points={pts([[21, -5, -0.35], [21, 4.6, -0.35], [21, 4.6, 0], [21, -5, 0]])} />
      <polygon className="floor-slab" points={pts([[-2.2, -5], [21, -5], [21, 4.6], [-2.2, 4.6]])} />
      {/* lane: the route crates take, drawn as a dashed path from agent dock to ledger dock */}
      <polyline
        className="floor-lane"
        points={[P(ax + 1.05, ay + 3.05), P(gx + 1.05, gy + 3.05), P(tx + 1.05, ty + 3.05), P(ex + 1.05, ey + 3.05), P(dx + 1.05, dy + 3.05), P(vx + 1.05, vy + 3.05), P(lx + 1.05, ly + 3.05)].map((p) => p.join(',')).join(' ')}
      />
      <polyline className="floor-lane" points={[P(ex + 1.05, ey + 3.05), P(SINK[0] + 1.05, SINK[1] + 1.05)].map((p) => p.join(',')).join(' ')} />

      {/* agent: a low studio with an antenna */}
      <Shadow x={ax} y={ay} w={2.2} d={2.2} />
      <Box x={ax} y={ay} w={2.2} d={2.2} h={1.5} className="st-agent" />
      <Box x={ax + 0.3} y={ay + 0.3} z={1.5} w={0.9} d={0.9} h={0.5} className="st-agent" />
      <line className="floor-wire" x1={P(ax + 1.8, ay + 0.5, 1.5)[0]} y1={P(ax + 1.8, ay + 0.5, 1.5)[1]} x2={P(ax + 1.8, ay + 0.5, 2.7)[0]} y2={P(ax + 1.8, ay + 0.5, 2.7)[1]} />
      <circle className="floor-lamp neutral" cx={P(ax + 1.8, ay + 0.5, 2.7)[0]} cy={P(ax + 1.8, ay + 0.5, 2.7)[1]} r={4} />

      {/* gate: two pillars and a beam; the lamp shows the last decision */}
      <Shadow x={gx} y={gy} w={2.2} d={2.2} />
      <Box x={gx} y={gy} w={0.6} d={2.2} h={2.6} className="st-gate" />
      <Box x={gx + 1.6} y={gy} w={0.6} d={2.2} h={2.6} className="st-gate" />
      <Box x={gx - 0.1} y={gy + 0.5} z={2.6} w={2.4} d={1.2} h={0.5} className="st-gate" />
      <circle data-testid="floor-gate" data-state={st.gate} className={`floor-lamp ${st.gate}`} cx={P(gx + 1.2, gy + 1.7, 3.1)[0]} cy={P(gx + 1.2, gy + 1.7, 3.1)[1]} r={6} />

      {/* tower: slim, with a scan beam while VERIFYING */}
      <Shadow x={tx} y={ty} w={2.2} d={2.2} />
      <Box x={tx} y={ty} w={2.2} d={2.2} h={0.5} className="st-tower" />
      <Box x={tx + 0.5} y={ty + 0.5} z={0.5} w={1.2} d={1.2} h={3.4} className="st-tower" />
      <Box x={tx + 0.3} y={ty + 0.3} z={3.9} w={1.6} d={1.6} h={0.5} className="st-tower" />
      <polygon data-testid="floor-beam" data-state={st.tower} className={`floor-beam ${st.tower}`} points={beam} fill="url(#floor-beam-fill)" />

      {/* escrow: a locked box; locked bonds sit on its roof, captured ones go to the sink */}
      <Shadow x={ex} y={ey} w={2.2} d={2.2} />
      <Box x={ex} y={ey} w={2.2} d={2.2} h={1.8} className={`st-escrow ${st.escrow.locked > 0 ? 'locked' : ''}`} />
      <polygon className="floor-lock" points={pts([[ex + 0.8, ey + 2.2, 0.6], [ex + 1.4, ey + 2.2, 0.6], [ex + 1.4, ey + 2.2, 1.2], [ex + 0.8, ey + 2.2, 1.2]])} />
      {Array.from({ length: Math.min(st.escrow.locked, 4) }, (_, i) => (
        <Box key={i} x={ex + 0.5 + (i % 2) * 0.7} y={ey + 0.5 + Math.floor(i / 2) * 0.7} z={1.8} w={0.55} d={0.55} h={0.4} className="st-bond" />
      ))}
      <Shadow x={SINK[0]} y={SINK[1]} w={2.2} d={2.2} />
      <Box x={SINK[0]} y={SINK[1]} w={2.2} d={2.2} h={0.35} className="st-sink" />

      {/* desk: low table; the brief floats above it while a human is being asked */}
      <Shadow x={dx} y={dy} w={2.2} d={2.2} />
      <Box x={dx} y={dy + 0.4} w={2.2} d={1.4} h={0.9} className="st-desk" />
      <Box x={dx + 0.2} y={dy + 1.9} w={0.7} d={0.5} h={0.6} className="st-desk chair" />
      <g data-testid="floor-brief" data-state={st.desk ? 'open' : 'idle'} className={`floor-card ${st.desk ? 'open' : ''}`} style={{ transform: `translate(${deskCard[0]}px, ${deskCard[1]}px)` }}>
        <rect x={-34} y={-44} width={68} height={44} rx={4} />
        <line x1={-26} y1={-34} x2={14} y2={-34} />
        <line x1={-26} y1={-26} x2={26} y2={-26} />
        <line x1={-26} y1={-18} x2={6} y2={-18} />
        <rect className="seal" x={10} y={-16} width={16} height={8} rx={2} />
      </g>

      {/* vault: heavy, with a sliding door and a glow on release */}
      <Shadow x={vx} y={vy} w={2.4} d={2.4} />
      <circle className={`floor-glow ${st.vault}`} cx={P(vx + 1.2, vy + 1.2, 1.2)[0]} cy={P(vx + 1.2, vy + 1.2, 1.2)[1]} r={70} fill="url(#floor-glow)" />
      <Box x={vx} y={vy} w={2.4} d={2.4} h={2.4} className={`st-vault ${st.vault}`} />
      <polygon
        data-testid="floor-vault"
        data-state={st.vault}
        className={`floor-door ${st.vault}`}
        points={pts([[vx + 2.4, vy + 0.6, 0.2], [vx + 2.4, vy + 1.8, 0.2], [vx + 2.4, vy + 1.8, 1.8], [vx + 2.4, vy + 0.6, 1.8]])}
      />

      {/* ledger: receipts stack as they are proven */}
      <Shadow x={lx} y={ly} w={2.2} d={2.2} />
      <Box x={lx} y={ly} w={2.2} d={2.2} h={1.1} className="st-ledger" />
      {Array.from({ length: Math.min(st.ledger, 8) }, (_, i) => (
        <Box key={i} x={lx + 0.4} y={ly + 0.5} z={1.1 + i * 0.16} w={1.4} d={1.1} h={0.12} className="st-receipt" />
      ))}

      {(['agent', 'gate', 'tower', 'escrow', 'desk', 'vault', 'ledger', 'sink'] as const).map((s) => (
        <Label key={s} station={s} />
      ))}

      {/* crates: one per action, translated to its station */}
      {crates.map(({ c, x, y, z }) => (
        <g
          key={c.id}
          data-testid="floor-crate"
          data-action={c.id}
          data-station={c.station}
          data-tone={c.tone}
          className={`floor-crate tone-${c.tone} ${selected === c.id ? 'selected' : ''}`}
          style={{ transform: shift(x, y, z) }}
          onClick={onSelect ? () => onSelect(c.id) : undefined}
          role={onSelect ? 'button' : undefined}
          tabIndex={onSelect ? 0 : undefined}
          onKeyDown={onSelect ? (e) => (e.key === 'Enter' || e.key === ' ') && onSelect(c.id) : undefined}
        >
          <title>{c.title}</title>
          <polygon className="crate-shadow" points={pts([[-0.1, -0.1, 0], [1.0, -0.1, 0], [1.2, 1.0, 0], [0.1, 1.0, 0]])} />
          <Box x={0} y={0} w={0.9} d={0.9} h={0.8} />
          <polygon className="crate-tape" points={pts([[0.38, 0, 0.8], [0.52, 0, 0.8], [0.52, 0.9, 0.8], [0.38, 0.9, 0.8]])} />
        </g>
      ))}
    </svg>
  );
}
