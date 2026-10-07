'use client';
import { Grid, Html, RoundedBox } from '@react-three/drei';
import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { CardView } from '../../lib/run';
import { budgetExhausted } from '../../lib/run';
import type { Crate, Floor } from '../floor/model';
import { type Palette, fallbackPalette, readPalette } from './palette';
import type { SceneProps } from './types';

/*
 * The courtyard: one isometric shot, no conveyor. The human sits at a desk in the middle with the vault behind them;
 * the agent, a small robot, stands at a turnstile on the left under a ring of three Chainlink CRE nodes; a glass jar
 * with the day's interrupt-budget slots stands between the gate and the desk, a grate beside it; receipts pin to a
 * board on the right. Every object that moves (request cards, bond coins, payments, the door, the pen) follows the
 * reducer's cards: nothing here advances on its own clock except the idle animations that a state switches on.
 * Frames are drawn on demand only.
 */
// ponytail: one mesh per card and per coin; runs have under ten. Instance them if a floor ever shows more than ~40.

const ISO = new THREE.Vector3(14, 14, 14);
const TARGET = new THREE.Vector3(-1.8, 1.0, -0.4);
/** World units across the fitted view. */
const VIEW_UNITS = 24;
const DOLLY_MS = 2000;

type V3 = [number, number, number];
type Portal = React.RefObject<HTMLDivElement>;
const DESK: V3 = [0, 0, 0.6];
const VAULT: V3 = [0.4, 0, -4.4];
const ROBOT: V3 = [-7.6, 0, 1.8];
const GATE: V3 = [-4.7, 0, 1.5];
const RING: V3 = [-4.7, 4.3, 1.5];
const JAR: V3 = [-2.3, 0, 2.5];
const GRATE: V3 = [-2.3, 0, 4.3];
const LEDGER: V3 = [5.4, 0, 0.4];
const EXIT: V3 = [11, 1.6, -3.4];
const CARD_TILT: V3 = [-0.25, Math.PI / 4, 0];

/** Where a request card rests for each crate station; k is its place among cards sharing the spot. */
function cardAnchor(c: Crate, k: number): { at: V3; rot: V3; flat: boolean } {
  switch (c.station) {
    case 'agent':
      return c.bounced
        ? { at: [ROBOT[0] - 1.1 - Math.floor(k / 3) * 0.7, 0.04 + (k % 3) * 0.035, ROBOT[2] + 1.3], rot: [-Math.PI / 2, 0, 0.3], flat: true }
        : { at: [ROBOT[0] + 0.75, 2.0 + k * 0.05, ROBOT[2] + 0.2], rot: CARD_TILT, flat: false };
    case 'gate':
    case 'tower':
      return { at: [GATE[0] + 0.1, 1.55 + k * 0.08, GATE[2] + 0.1 + k * 0.18], rot: CARD_TILT, flat: false };
    case 'escrow':
      return { at: [GATE[0] + 1.3, 1.7 + k * 0.08, GATE[2] + 0.5 + k * 0.18], rot: CARD_TILT, flat: false };
    case 'desk':
      return { at: [DESK[0] - 0.25 + k * 0.3, 1.0 + k * 0.02, DESK[2] + 0.1], rot: [-Math.PI / 2, 0, 0.18], flat: true };
    case 'vault':
      return { at: [VAULT[0], 1.7, VAULT[2] + 1.0], rot: [0, 0, 0], flat: false };
    case 'ledger':
      return { at: [LEDGER[0] - 0.62 + (k % 3) * 0.62, 2.45 - Math.floor(k / 3) * 0.62, LEDGER[2] + 0.17], rot: [0, 0, 0], flat: false };
    case 'sink':
      return { at: [GRATE[0] + ((k % 2) - 0.5) * 0.3, -0.25, GRATE[2]], rot: [-Math.PI / 2, 0, 0.4], flat: true };
  }
}

function cardColor(c: CardView, p: Palette): string {
  if (c.state === 'DENIED') return c.bond?.status === 'captured' ? p.captured : p.denied;
  if (c.state === 'SETTLED' || c.state === 'PROVEN' || c.state === 'AUTHORIZED' || c.state === 'EXECUTING') return p.settled;
  if (c.bond?.status === 'locked') return p.bond;
  if (c.state === 'ESCALATED') return p.escalated;
  return p.proposed;
}

export function Floor3D({ floor, selected, onSelect, cards = [], treasury = null }: SceneProps) {
  const wrap = useRef<HTMLDivElement>(null);
  // drei Html rebuilds its React root when its default target flips from the canvas parent to the events element after
  // the first commit, which blanks every Html mounted in that commit. A portal we own never changes.
  const portal = useRef<HTMLDivElement>(null) as Portal;
  const [pal, setPal] = useState<Palette>(fallbackPalette);
  useLayoutEffect(() => {
    const el = wrap.current?.closest('.floor') ?? wrap.current;
    if (el) setPal(readPalette(el));
  }, []);
  const st = floor.stations;
  const perDay = cards.find((c) => c.approval?.brief)?.approval?.brief?.cost.interrupt_budget.per_day ?? 3;
  const latest = cards[cards.length - 1] ?? null;
  const byId = useMemo(() => new Map(cards.map((c) => [c.actionId, c])), [cards]);
  const decided = cards.filter((c) => c.approval && c.approval.status !== 'pending').length;
  return (
    <div ref={wrap} data-testid="floor-3d" className="floor-3d">
      <div ref={portal} className="floor-3d-portal" />
      <Canvas
        orthographic
        shadows="percentage"
        flat
        frameloop="demand"
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true }}
        camera={{ position: ISO.clone().add(TARGET).toArray(), zoom: 40, near: 0.1, far: 120 }}
      >
        <Camera />
        <Lights pal={pal} />
        <Ground pal={pal} />
        <Robot pal={pal} portal={portal} />
        <Gate pal={pal} portal={portal} decision={st.gate} evaluating={latest?.state === 'EVALUATING'} exhausted={latest ? budgetExhausted(latest) : false} />
        <Ring pal={pal} portal={portal} scanning={st.tower === 'scanning'} />
        <Jar pal={pal} portal={portal} slots={perDay} />
        <Grate pal={pal} portal={portal} />
        <Desk pal={pal} portal={portal} open={st.desk !== null} decided={decided} />
        <Vault pal={pal} portal={portal} open={st.vault === 'releasing'} rejected={st.vault === 'rejected'} />
        <Html portal={portal} position={[VAULT[0], 3.55, VAULT[2] + 1.5]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
          <span className="floor-plaque" data-testid="floor-treasury">
            {treasury ? `TREASURY ${treasury}` : 'TREASURY'}
          </span>
        </Html>
        <Ledger pal={pal} portal={portal} />
        {floor.crates.map((c, i) => (
          <RequestCard key={c.id} crate={c} card={byId.get(c.id) ?? null} slot={slotOf(floor.crates, i)} pal={pal} portal={portal} selected={selected === c.id} onSelect={onSelect ?? null} />
        ))}
        {coinsOf(cards).map((b) => (
          <BondCoin key={b.id} status={b.status} slot={b.slot} pal={pal} />
        ))}
        {cards
          .filter((c) => c.state === 'SETTLED' || c.state === 'PROVEN')
          .map((c) => (
            <Payment key={c.actionId} pal={pal} />
          ))}
        <Ticker floor={floor} />
      </Canvas>
      <ul className="floor-state" aria-label="Courtyard state">
        <li data-testid="floor-gate" data-state={st.gate}>
          Authority Engine: {st.gate}
        </li>
        <li data-testid="floor-beam" data-state={st.tower}>
          Chainlink CRE: {st.tower}
        </li>
        <li data-testid="floor-brief" data-state={st.desk ? 'open' : 'idle'}>
          Human: {st.desk ? 'reading a brief' : 'idle'}
        </li>
        <li data-testid="floor-vault" data-state={st.vault}>
          Treasury vault: {st.vault}
        </li>
      </ul>
    </div>
  );
}

/** Fixed isometric camera, fitted to the container width, with one gentle dolly-in on first load. */
function Camera() {
  const { camera, size, invalidate, clock } = useThree();
  const start = useRef<number | null>(null);
  const base = size.width / VIEW_UNITS;
  useLayoutEffect(() => {
    camera.position.copy(ISO).add(TARGET);
    camera.lookAt(TARGET);
    camera.zoom = base;
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, base, invalidate]);
  useFrame(() => {
    if (start.current === null) start.current = clock.getElapsedTime();
    const t = Math.min(1, ((clock.getElapsedTime() - start.current) * 1000) / DOLLY_MS);
    const ease = 1 - Math.pow(1 - t, 3);
    camera.zoom = base * (0.9 + 0.1 * ease);
    camera.updateProjectionMatrix();
    if (t < 1) invalidate();
  });
  return null;
}

/** Keeps frames coming while something is animating on its own (lamps, ring, glow, brief). Moving objects ask for their own. */
function Ticker({ floor }: { floor: Floor }) {
  const st = floor.stations;
  const alive = st.tower === 'scanning' || st.desk !== null || st.vault === 'releasing' || st.gate === 'idle';
  const { invalidate } = useThree();
  useFrame(() => {
    if (alive) invalidate();
  });
  useEffect(() => {
    invalidate();
  }, [floor, invalidate]);
  return null;
}

function Lights({ pal }: { pal: Palette }) {
  return (
    <>
      <hemisphereLight args={['#fff8ef', pal.warm2, 1.2]} />
      <directionalLight
        color="#ffe9d2"
        intensity={2.4}
        position={[5, 11, 9]}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
        shadow-camera-near={1}
        shadow-camera-far={60}
      />
    </>
  );
}

function Ground({ pal }: { pal: Palette }) {
  return (
    <group>
      <RoundedBox args={[26, 0.5, 15]} radius={0.18} smoothness={3} position={[-0.6, -0.25, 0.4]} receiveShadow>
        <meshStandardMaterial color={pal.paper} roughness={1} />
      </RoundedBox>
      <Grid
        position={[-0.6, 0.003, 0.4]}
        args={[26, 15]}
        cellSize={1}
        cellThickness={0.7}
        cellColor={pal.grid}
        sectionSize={5}
        sectionThickness={1.1}
        sectionColor={pal.grid}
        fadeDistance={80}
        fadeStrength={0}
        infiniteGrid={false}
      />
    </group>
  );
}

function Mat({ color, roughness = 0.85, metalness = 0 }: { color: string; roughness?: number; metalness?: number }) {
  return <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} />;
}

function Block({ size, at, color, radius = 0.08, rot }: { size: V3; at: V3; color: string; radius?: number; rot?: V3 }) {
  return (
    <RoundedBox args={size} radius={Math.min(radius, Math.min(...size) / 2.01)} smoothness={3} position={[at[0], at[1] + size[1] / 2, at[2]]} rotation={rot ?? [0, 0, 0]} castShadow receiveShadow>
      <Mat color={color} />
    </RoundedBox>
  );
}

/** A label that appears while the pointer rests on the object. */
function Hover({ label, at, portal, children }: { label: string; at: V3; portal: Portal; children: React.ReactNode }) {
  const [on, setOn] = useState(false);
  const { invalidate } = useThree();
  return (
    <group
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        setOn(true);
        invalidate();
      }}
      onPointerOut={() => {
        setOn(false);
        invalidate();
      }}
    >
      {children}
      {on ? (
        <Html portal={portal} position={at} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
          <span className="floor-pin">{label}</span>
        </Html>
      ) : null}
    </group>
  );
}

/** Eases a number toward a target each frame and asks for the next frame until it arrives. */
function useEase(target: number, rate = 7): React.RefObject<number> {
  const v = useRef(target);
  const { invalidate } = useThree();
  useFrame((_, dt) => {
    const d = target - v.current;
    if (Math.abs(d) < 0.002) {
      v.current = target;
      return;
    }
    v.current += d * Math.min(1, dt * rate);
    invalidate();
  });
  useEffect(() => {
    invalidate();
  }, [target, invalidate]);
  return v;
}

/* ---------- the agent: a small rounded robot with a satchel of coins ---------- */
function Robot({ pal, portal }: { pal: Palette; portal: Portal }) {
  const [x, , z] = ROBOT;
  return (
    <Hover portal={portal} label="Agent" at={[x, 3.0, z]}>
      <group position={[x, 0, z]} rotation={[0, Math.PI / 2 - 0.5, 0]}>
        <Block size={[0.5, 0.3, 0.4]} at={[-0.28, 0, 0]} color={pal.ink} radius={0.1} />
        <Block size={[0.5, 0.3, 0.4]} at={[0.28, 0, 0]} color={pal.ink} radius={0.1} />
        <RoundedBox args={[1.2, 1.1, 0.9]} radius={0.3} smoothness={4} position={[0, 0.9, 0]} castShadow>
          <Mat color={pal.tint2} />
        </RoundedBox>
        <RoundedBox args={[1.0, 0.8, 0.9]} radius={0.3} smoothness={4} position={[0, 1.9, 0]} castShadow>
          <Mat color={pal.tint1} />
        </RoundedBox>
        <mesh position={[0, 1.95, 0.46]}>
          <boxGeometry args={[0.7, 0.3, 0.04]} />
          <Mat color={pal.ink} roughness={0.4} />
        </mesh>
        {[-0.17, 0.17].map((ex) => (
          <mesh key={ex} position={[ex, 1.95, 0.49]}>
            <sphereGeometry args={[0.06, 12, 12]} />
            <meshStandardMaterial color={pal.tint4} emissive={pal.tint4} emissiveIntensity={1.2} />
          </mesh>
        ))}
        <mesh position={[0, 2.45, 0]}>
          <cylinderGeometry args={[0.03, 0.03, 0.35, 8]} />
          <Mat color={pal.ink} />
        </mesh>
        <mesh position={[0, 2.66, 0]}>
          <sphereGeometry args={[0.09, 12, 12]} />
          <meshStandardMaterial color={pal.denied} emissive={pal.denied} emissiveIntensity={0.6} />
        </mesh>
        <RoundedBox args={[0.22, 0.7, 0.22]} radius={0.1} position={[-0.72, 0.95, 0]} rotation={[0, 0, 0.2]} castShadow>
          <Mat color={pal.tint3} />
        </RoundedBox>
        <RoundedBox args={[0.22, 0.75, 0.22]} radius={0.1} position={[0.72, 1.3, 0.1]} rotation={[-0.4, 0, -1.0]} castShadow>
          <Mat color={pal.tint3} />
        </RoundedBox>
        {/* satchel on the hip with a strap and a coin peeking out */}
        <RoundedBox args={[0.55, 0.45, 0.25]} radius={0.08} position={[-0.45, 0.55, 0.45]} rotation={[0, 0, 0.1]} castShadow>
          <Mat color={pal.warm2} />
        </RoundedBox>
        <mesh position={[0.1, 1.25, 0.5]} rotation={[0, 0, -0.8]}>
          <boxGeometry args={[0.08, 1.1, 0.03]} />
          <Mat color={pal.warm2} />
        </mesh>
        <mesh position={[-0.4, 0.8, 0.5]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.14, 0.14, 0.05, 20]} />
          <Mat color={pal.bond} roughness={0.4} metalness={0.3} />
        </mesh>
      </group>
    </Hover>
  );
}

/* ---------- the gate: a turnstile with three lamps ---------- */
function Gate({ pal, portal, decision, evaluating, exhausted }: { pal: Palette; portal: Portal; decision: Floor['stations']['gate']; evaluating: boolean; exhausted: boolean }) {
  const [x, , z] = GATE;
  const lamps = useRef<THREE.MeshStandardMaterial[]>([]);
  const arm = useRef<THREE.Group>(null);
  const spin = useEase(decision === 'ALLOW' ? 1 : 0, 4);
  const colors = [pal.permit, pal.cosign, pal.forbid];
  const lit = decision === 'ALLOW' ? 0 : decision === 'ESCALATE' ? 1 : decision === 'DENY' ? 2 : -1;
  const dimmed = useMemo(() => colors.map((c) => new THREE.Color(c).lerp(new THREE.Color(pal.warm1), 0.6)), [pal]); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    lamps.current.forEach((m, i) => {
      if (!m) return;
      let k = i === lit ? 1 : 0;
      if (evaluating) k = 0.35 + (Math.sin(t * 6 + i * 2) + 1) * 0.3;
      if (exhausted && i === 1) k = Math.sin(t * 9) > 0 ? 1 : 0.1;
      m.emissiveIntensity = k * 1.4;
      m.color.copy(k > 0.2 ? new THREE.Color(colors[i]) : dimmed[i]!);
    });
    if (arm.current) arm.current.rotation.y = (spin.current * (Math.PI * 2)) / 3;
  });
  return (
    <Hover portal={portal} label="Authority Engine" at={[x, 3.0, z]}>
      <group position={[x, 0, z]}>
        <Block size={[1.6, 0.25, 2.8]} at={[0, 0, 0]} color={pal.warm1} radius={0.1} />
        <Block size={[0.45, 2.3, 0.45]} at={[0, 0.25, -1.0]} color={pal.tint4} radius={0.12} />
        <Block size={[0.45, 1.3, 0.45]} at={[0, 0.25, 1.0]} color={pal.tint4} radius={0.12} />
        <group ref={arm} position={[0, 1.4, 1.0]}>
          {[0, 1, 2].map((i) => (
            <group key={i} rotation={[0, (i * Math.PI * 2) / 3, 0]}>
              <mesh position={[0, 0, 0.55]} rotation={[Math.PI / 2, 0, 0]} castShadow>
                <cylinderGeometry args={[0.06, 0.06, 1.1, 10]} />
                <Mat color={pal.ink} roughness={0.5} />
              </mesh>
            </group>
          ))}
        </group>
        {colors.map((c, i) => (
          <mesh key={c} position={[0.3, 2.35 - i * 0.42, -1.0]} castShadow>
            <sphereGeometry args={[0.16, 18, 18]} />
            <meshStandardMaterial
              ref={(m) => {
                if (m) lamps.current[i] = m;
              }}
              color={c}
              emissive={c}
              emissiveIntensity={0}
              roughness={0.4}
            />
          </mesh>
        ))}
      </group>
    </Hover>
  );
}

/* ---------- Chainlink CRE: a ring of three hexagonal nodes over the gate ---------- */
function Ring({ pal, portal, scanning }: { pal: Palette; portal: Portal; scanning: boolean }) {
  const nodes = useRef<THREE.MeshStandardMaterial[]>([]);
  const beam = useRef<THREE.MeshBasicMaterial>(null);
  const group = useRef<THREE.Group>(null);
  const on = useEase(scanning ? 1 : 0, 5);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const phase = (t % 2.0) / 2.0; // node 0, node 1, node 2, then all three (consensus)
    nodes.current.forEach((m, i) => {
      if (!m) return;
      const mine = phase < 0.75 ? Math.floor(phase / 0.25) === i : true;
      m.emissiveIntensity = scanning ? (mine ? 1.6 : 0.15) : 0.25;
    });
    if (beam.current) beam.current.opacity = on.current * (phase >= 0.75 ? 0.5 : 0.22 + 0.1 * Math.sin(t * 10));
    if (group.current) group.current.rotation.y = scanning ? t * 0.4 : 0;
  });
  const r = 0.95;
  return (
    <Hover portal={portal} label="Chainlink CRE" at={[RING[0], RING[1] + 1.3, RING[2]]}>
      <group position={RING}>
        <group ref={group}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[r, 0.05, 10, 48]} />
            <Mat color={pal.ink} roughness={0.5} />
          </mesh>
          {[0, 1, 2].map((i) => {
            const a = (i * Math.PI * 2) / 3 + Math.PI / 6;
            return (
              <mesh key={i} position={[Math.cos(a) * r, 0, Math.sin(a) * r]} rotation={[0, a, 0]} castShadow>
                <cylinderGeometry args={[0.36, 0.36, 0.28, 6]} />
                <meshStandardMaterial
                  ref={(m) => {
                    if (m) nodes.current[i] = m;
                  }}
                  color={pal.tint4}
                  emissive={pal.tint4}
                  emissiveIntensity={0.25}
                  roughness={0.5}
                />
              </mesh>
            );
          })}
        </group>
        <mesh position={[0, -1.4, -1.0]}>
          <cylinderGeometry args={[0.04, 0.04, 2.8, 8]} />
          <Mat color={pal.ink} />
        </mesh>
        <mesh position={[0, -1.4, 0.05]} rotation={[0, Math.PI / 4, 0]}>
          <planeGeometry args={[0.9, 2.7]} />
          <meshBasicMaterial ref={beam} color={pal.tint4} transparent opacity={0} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      </group>
    </Hover>
  );
}

/* ---------- escrow: a glass jar on a pedestal with one slot per interruption of the day's budget ---------- */
const JAR_SLOT_Y = (slot: number) => 1.25 + slot * 0.36;
function Jar({ pal, portal, slots }: { pal: Palette; portal: Portal; slots: number }) {
  const [x, , z] = JAR;
  return (
    <Hover portal={portal} label={`Bond escrow, ${slots} slots`} at={[x, JAR_SLOT_Y(slots) + 0.9, z]}>
      <group position={[x, 0, z]}>
        <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.55, 0.65, 1.0, 24]} />
          <Mat color={pal.warm2} />
        </mesh>
        <mesh position={[0, 1.0 + (slots * 0.36 + 0.5) / 2, 0]}>
          <cylinderGeometry args={[0.5, 0.5, slots * 0.36 + 0.5, 32, 1, true]} />
          <meshPhysicalMaterial color="#d9f0f7" transparent opacity={0.28} roughness={0.1} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
        <mesh position={[0, 1.0 + slots * 0.36 + 0.55, 0]} castShadow>
          <cylinderGeometry args={[0.54, 0.54, 0.12, 32]} />
          <Mat color={pal.tint4} roughness={0.5} />
        </mesh>
        {Array.from({ length: slots }, (_, i) => (
          <mesh key={i} position={[0, JAR_SLOT_Y(i) - 0.12, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.42, 0.02, 8, 32]} />
            <Mat color={pal.ink} />
          </mesh>
        ))}
      </group>
    </Hover>
  );
}

function Grate({ pal, portal }: { pal: Palette; portal: Portal }) {
  const [x, , z] = GRATE;
  return (
    <Hover portal={portal} label="Sink" at={[x, 1.2, z]}>
      <group position={[x, 0, z]}>
        <mesh position={[0, -0.18, 0]}>
          <boxGeometry args={[1.3, 0.4, 1.3]} />
          <Mat color={pal.ink} />
        </mesh>
        {[-0.45, -0.15, 0.15, 0.45].map((sx) => (
          <mesh key={sx} position={[sx, 0.03, 0]} castShadow>
            <boxGeometry args={[0.14, 0.06, 1.3]} />
            <Mat color={pal.captured} roughness={0.6} />
          </mesh>
        ))}
        <mesh position={[0, 0.03, 0]}>
          <boxGeometry args={[1.4, 0.06, 0.12]} />
          <Mat color={pal.captured} roughness={0.6} />
        </mesh>
      </group>
    </Hover>
  );
}

/* ---------- the human at the desk, a pen in hand, a hardware wallet by the elbow ---------- */
function Desk({ pal, portal, open, decided }: { pal: Palette; portal: Portal; open: boolean; decided: number }) {
  const [x, , z] = DESK;
  const arm = useRef<THREE.Group>(null);
  const glow = useRef<THREE.PointLight>(null);
  const strokeUntil = useRef(0);
  const seen = useRef(decided);
  const { clock, invalidate } = useThree();
  const lit = useEase(open ? 1 : 0, 5);
  useEffect(() => {
    if (decided > seen.current) {
      strokeUntil.current = clock.getElapsedTime() + 1.4;
      invalidate();
    }
    seen.current = decided;
  }, [decided, clock, invalidate]);
  useFrame(() => {
    const t = clock.getElapsedTime();
    if (arm.current) {
      const stroking = t < strokeUntil.current;
      arm.current.rotation.z = stroking ? Math.sin(t * 14) * 0.2 : 0;
      arm.current.rotation.x = stroking ? -0.1 + Math.sin(t * 7) * 0.08 : 0;
      if (stroking) invalidate();
    }
    if (glow.current) glow.current.intensity = lit.current * 6;
  });
  return (
    <Hover portal={portal} label="Human" at={[x, 3.4, z - 0.6]}>
      <group position={[x, 0, z]}>
        <Block size={[2.6, 0.12, 1.3]} at={[0, 0.85, 0]} color={pal.warm1} radius={0.05} />
        <Block size={[0.12, 0.85, 1.1]} at={[-1.15, 0, 0]} color={pal.warm2} radius={0.03} />
        <Block size={[0.12, 0.85, 1.1]} at={[1.15, 0, 0]} color={pal.warm2} radius={0.03} />
        <RoundedBox args={[0.42, 0.08, 0.26]} radius={0.03} position={[0.85, 1.01, 0.3]} rotation={[0, -0.3, 0]} castShadow>
          <Mat color={pal.ink} roughness={0.5} />
        </RoundedBox>
        <mesh position={[0.85, 1.055, 0.3]} rotation={[-Math.PI / 2, 0, -0.3]}>
          <planeGeometry args={[0.22, 0.14]} />
          <meshStandardMaterial color={pal.permit} emissive={pal.permit} emissiveIntensity={0.9} />
        </mesh>
        <group position={[0, 0, -1.0]}>
          <Block size={[1.0, 0.45, 0.9]} at={[0, 0, 0]} color={pal.tint4} radius={0.12} />
          <Block size={[1.0, 1.4, 0.2]} at={[0, 0.45, -0.45]} color={pal.tint4} radius={0.08} />
          <Block size={[0.3, 0.3, 1.0]} at={[-0.25, 0.45, 0.45]} color={pal.ink} radius={0.1} />
          <Block size={[0.3, 0.3, 1.0]} at={[0.25, 0.45, 0.45]} color={pal.ink} radius={0.1} />
          <RoundedBox args={[1.1, 1.3, 0.6]} radius={0.22} smoothness={4} position={[0, 1.35, 0]} castShadow>
            <Mat color={pal.vault} />
          </RoundedBox>
          <mesh position={[0, 2.45, 0]} castShadow>
            <sphereGeometry args={[0.38, 24, 24]} />
            <Mat color="#e8c4a8" roughness={0.7} />
          </mesh>
          <mesh position={[0, 2.5, -0.05]}>
            <sphereGeometry args={[0.4, 24, 24, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <Mat color={pal.ink} />
          </mesh>
          <RoundedBox args={[0.24, 0.9, 0.24]} radius={0.1} position={[-0.7, 1.35, 0.35]} rotation={[-1.2, 0, 0.2]} castShadow>
            <Mat color={pal.vault} />
          </RoundedBox>
          <group ref={arm} position={[0.62, 1.85, 0.1]}>
            <RoundedBox args={[0.24, 0.95, 0.24]} radius={0.1} position={[0, -0.45, 0]} rotation={[-0.9, 0, 0]} castShadow>
              <Mat color={pal.vault} />
            </RoundedBox>
            <mesh position={[0.05, -0.75, 0.6]} rotation={[0.9, 0, 0.3]}>
              <cylinderGeometry args={[0.03, 0.03, 0.5, 8]} />
              <Mat color={pal.ink} roughness={0.4} />
            </mesh>
          </group>
        </group>
        <pointLight ref={glow} color={pal.cosign} intensity={0} distance={4} decay={2} position={[0, 1.8, 0.2]} />
      </group>
    </Hover>
  );
}

/* ---------- the vault: a safe with a round door, a wheel, and the balance on a plaque ---------- */
function Vault({ pal, portal, open, rejected }: { pal: Palette; portal: Portal; open: boolean; rejected: boolean }) {
  const [x, , z] = VAULT;
  const door = useRef<THREE.Group>(null);
  const light = useRef<THREE.PointLight>(null);
  const swing = useEase(open ? 1 : 0, 3.5);
  useFrame(({ clock }) => {
    if (door.current) door.current.rotation.y = swing.current * 1.9;
    if (light.current) light.current.intensity = swing.current * (10 + Math.sin(clock.getElapsedTime() * 3) * 2);
  });
  const w = 3.8;
  const h = 3.9;
  const d = 2.8;
  return (
    <Hover portal={portal} label="Treasury vault" at={[x, h + 1.0, z]}>
      <group position={[x, 0, z]}>
        <RoundedBox args={[w, h, d]} radius={0.2} smoothness={4} position={[0, h / 2, 0]} castShadow receiveShadow>
          <Mat color={rejected ? pal.denied : pal.vault} />
        </RoundedBox>
        <mesh position={[0, h / 2, d / 2 + 0.02]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[1.3, 1.3, 0.08, 40]} />
          <Mat color={pal.ink} roughness={0.5} />
        </mesh>
        <mesh position={[0, h / 2, d / 2 - 0.3]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[1.15, 1.15, 0.6, 40]} />
          <meshStandardMaterial color="#071a2b" roughness={1} />
        </mesh>
        <group ref={door} position={[1.2, h / 2, d / 2 + 0.08]}>
          <mesh position={[-1.2, 0, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[1.18, 1.18, 0.26, 40]} />
            <Mat color={pal.tint4} roughness={0.5} metalness={0.2} />
          </mesh>
          <mesh position={[-1.2, 0, 0.22]}>
            <torusGeometry args={[0.5, 0.06, 10, 32]} />
            <Mat color={pal.warm1} roughness={0.4} metalness={0.3} />
          </mesh>
          {[0, 1, 2].map((i) => (
            <mesh key={i} position={[-1.2, 0, 0.22]} rotation={[0, 0, (i * Math.PI) / 3]}>
              <boxGeometry args={[1.0, 0.06, 0.06]} />
              <Mat color={pal.warm1} roughness={0.4} metalness={0.3} />
            </mesh>
          ))}
        </group>
        <pointLight ref={light} color={pal.glow} intensity={0} distance={9} decay={2} position={[0, h / 2, d / 2 + 1.4]} />
      </group>
    </Hover>
  );
}

/* ---------- receipts: a pinned board on the right ---------- */
function Ledger({ pal, portal }: { pal: Palette; portal: Portal }) {
  const [x, , z] = LEDGER;
  return (
    <Hover portal={portal} label="Receipts" at={[x, 3.9, z]}>
      <group position={[x, 0, z]}>
        <Block size={[0.16, 3.4, 0.16]} at={[-1.0, 0, 0]} color={pal.ink} radius={0.04} />
        <Block size={[0.16, 3.4, 0.16]} at={[1.0, 0, 0]} color={pal.ink} radius={0.04} />
        <RoundedBox args={[2.5, 2.4, 0.12]} radius={0.06} smoothness={3} position={[0, 2.1, 0.08]} castShadow receiveShadow>
          <Mat color={pal.warm2} />
        </RoundedBox>
      </group>
    </Hover>
  );
}

/** Place of crate i among the crates sharing its spot. */
function slotOf(crates: Crate[], i: number): number {
  const c = crates[i]!;
  let k = 0;
  for (let j = 0; j < i; j++) {
    const o = crates[j]!;
    if (o.station === c.station && o.bounced === c.bounced) k++;
  }
  return k;
}

/** Moves a group toward an anchor with an arc; snaps there on first mount; asks for frames while travelling. */
function useTravel(g: React.RefObject<THREE.Group | null>, at: V3, rot: V3, hop: number, onArrive?: () => void) {
  const { invalidate } = useThree();
  const target = useMemo(() => new THREE.Vector3(...at), [at]);
  const euler = useMemo(() => new THREE.Euler(...rot), [rot]);
  const first = useRef(true);
  const total = useRef(0);
  const moving = useRef(false);
  const arrive = useRef(onArrive);
  arrive.current = onArrive;
  useEffect(() => {
    if (!g.current) return;
    if (first.current) {
      first.current = false;
      g.current.position.copy(target);
      g.current.rotation.copy(euler);
    } else {
      total.current = g.current.position.distanceTo(target);
      moving.current = total.current > 0.01;
    }
    invalidate();
  }, [g, target, euler, invalidate]);
  useFrame((_, dt) => {
    const p = g.current;
    if (!p) return;
    const d = p.position.distanceTo(target);
    if (d < 0.004) {
      if (moving.current) {
        moving.current = false;
        p.position.copy(target);
        p.rotation.copy(euler);
        arrive.current?.();
        invalidate();
      }
      return;
    }
    const k = Math.min(1, dt * 4.2);
    p.position.x += (target.x - p.position.x) * k;
    p.position.z += (target.z - p.position.z) * k;
    const frac = total.current > 0 ? Math.min(1, p.position.distanceTo(target) / total.current) : 0;
    p.position.y += (target.y + Math.sin(frac * Math.PI) * hop - p.position.y) * Math.min(1, dt * 6);
    p.rotation.x += (euler.x - p.rotation.x) * k;
    p.rotation.y += (euler.y - p.rotation.y) * k;
    p.rotation.z += (euler.z - p.rotation.z) * k;
    invalidate();
  });
}

/* ---------- a request card: the paper the agent sends, the human reads, the vault settles, the board pins ---------- */
function RequestCard({ crate, card, slot, pal, portal, selected, onSelect }: { crate: Crate; card: CardView | null; slot: number; pal: Palette; portal: Portal; selected: boolean; onSelect: ((id: string) => void) | null }) {
  const g = useRef<THREE.Group>(null);
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const [hover, setHover] = useState(false);
  const { at, rot, flat } = useMemo(() => cardAnchor(crate, slot), [crate, slot]);
  const dim = crate.bounced || crate.station === 'sink' ? 0.55 : crate.station === 'vault' ? 0.35 : 1;
  const fade = useEase(dim, 2.5);
  useTravel(g, at, rot, crate.bounced ? 1.6 : crate.station === 'sink' ? 0.9 : 0.7);
  const onDesk = crate.station === 'desk';
  useFrame(({ clock }) => {
    if (!mat.current) return;
    mat.current.opacity = fade.current;
    mat.current.emissiveIntensity = onDesk ? 0.35 + Math.sin(clock.getElapsedTime() * 3) * 0.15 : hover || selected ? 0.25 : 0;
  });
  const color = card ? cardColor(card, pal) : pal.proposed;
  const declined = card?.approval?.status === 'declined';
  return (
    <group
      ref={g}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.(crate.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHover(false);
        document.body.style.cursor = '';
      }}
    >
      <mesh castShadow scale={selected || hover ? 1.12 : 1}>
        <boxGeometry args={[0.72, 0.52, 0.03]} />
        <meshStandardMaterial ref={mat} color="#fffdf8" roughness={0.95} emissive={color} emissiveIntensity={0} transparent opacity={1} />
      </mesh>
      <mesh position={[0, 0.2, 0.017]}>
        <planeGeometry args={[0.72, 0.1]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      {[0.07, -0.02, -0.11].map((y, i) => (
        <mesh key={i} position={[-0.1 + i * 0.04, y, 0.017]}>
          <planeGeometry args={[0.42 - i * 0.1, 0.03]} />
          <meshStandardMaterial color={pal.captured} roughness={1} />
        </mesh>
      ))}
      {declined ? (
        <group position={[0.14, -0.08, 0.02]}>
          {[0.8, -0.8].map((r) => (
            <mesh key={r} rotation={[0, 0, r]}>
              <planeGeometry args={[0.34, 0.06]} />
              <meshStandardMaterial color={pal.forbid} roughness={0.8} />
            </mesh>
          ))}
        </group>
      ) : null}
      {selected ? (
        <mesh position={[0, flat ? 0 : -0.3, flat ? -0.02 : 0]} rotation={flat ? [0, 0, 0] : [-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.5, 0.58, 40]} />
          <meshBasicMaterial color={pal.ink} transparent opacity={0.6} side={THREE.DoubleSide} />
        </mesh>
      ) : null}
      <Html portal={portal} center zIndexRange={[4, 0]}>
        <button
          type="button"
          className="floor-crate-hit"
          data-testid="floor-crate"
          data-action={crate.id}
          data-station={crate.station}
          data-tone={crate.tone}
          aria-label={crate.title}
          title={crate.title}
          onClick={() => onSelect?.(crate.id)}
          onFocus={() => setHover(true)}
          onBlur={() => setHover(false)}
        />
      </Html>
    </group>
  );
}

/* ---------- bond coins: from the satchel into a jar slot, back to the satchel, or down the grate ---------- */
type CoinStatus = 'satchel' | 'jar' | 'refunded' | 'captured';
function coinsOf(cards: CardView[]): Array<{ id: string; status: CoinStatus; slot: number }> {
  const taken = new Set<number>();
  const out: Array<{ id: string; status: CoinStatus; slot: number }> = [];
  for (const c of cards) {
    if (!c.bond) continue;
    const s = c.bond.status;
    const status: CoinStatus = s === 'locked' ? 'jar' : s === 'captured' ? 'captured' : s === 'required' ? 'satchel' : 'refunded';
    let slot = 0;
    if (status === 'jar') {
      while (taken.has(slot)) slot++;
      taken.add(slot);
    }
    out.push({ id: c.actionId, status, slot });
  }
  return out;
}

const SATCHEL: V3 = [ROBOT[0] - 0.3, 0.75, ROBOT[2] + 0.5];
const GRATE_BOTTOM: V3 = [GRATE[0], -0.6, GRATE[2]];
const STILL: V3 = [0, 0, 0];
const SUNK: V3 = [0.3, 0, 0.4];
function BondCoin({ status, slot, pal }: { status: CoinStatus; slot: number; pal: Palette }) {
  const g = useRef<THREE.Group>(null);
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const anchor = useMemo<V3>(() => (status === 'jar' ? [JAR[0], JAR_SLOT_Y(slot), JAR[2]] : status === 'captured' ? GRATE_BOTTOM : SATCHEL), [status, slot]);
  const [arrived, setArrived] = useState(true);
  useEffect(() => {
    setArrived(false);
  }, [status]);
  useTravel(g, anchor, status === 'captured' ? SUNK : STILL, status === 'captured' ? 0.5 : 1.5, () => setArrived(true));
  const show = status === 'jar' || !arrived;
  const flash = useRef<THREE.PointLight>(null);
  const k = useEase(show ? 1 : 0, 4);
  useFrame(() => {
    if (mat.current) mat.current.opacity = k.current;
    if (flash.current) flash.current.intensity = status === 'captured' && !arrived ? 4 : 0;
  });
  return (
    <group ref={g}>
      <mesh castShadow>
        <cylinderGeometry args={[0.3, 0.3, 0.12, 24]} />
        <meshStandardMaterial ref={mat} color={pal.bond} roughness={0.35} metalness={0.4} transparent opacity={1} />
      </mesh>
      <mesh position={[0, 0.061, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.14, 0.2, 24]} />
        <meshStandardMaterial color={pal.warm1} roughness={0.4} metalness={0.3} />
      </mesh>
      <pointLight ref={flash} color={pal.captured} intensity={0} distance={2.5} decay={2} position={[0, 0.6, 0]} />
    </group>
  );
}

/* ---------- a payment: one coin leaves the open vault toward the right edge and fades ---------- */
const VAULT_MOUTH = new THREE.Vector3(VAULT[0], 1.9, VAULT[2] + 1.6);
const EXIT_V = new THREE.Vector3(...EXIT);
function Payment({ pal }: { pal: Palette }) {
  const g = useRef<THREE.Group>(null);
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const { invalidate } = useThree();
  const gone = useRef(false);
  useEffect(() => {
    g.current?.position.copy(VAULT_MOUTH);
    invalidate();
  }, [invalidate]);
  useFrame((_, dt) => {
    const p = g.current;
    if (!p || gone.current || !mat.current) return;
    const d = p.position.distanceTo(EXIT_V);
    p.position.lerp(EXIT_V, Math.min(1, dt * 1.6));
    p.position.y = EXIT[1] + Math.sin((d / 12) * Math.PI) * 1.2;
    p.rotation.y += dt * 4;
    mat.current.opacity = Math.min(1, d / 3);
    if (d < 0.15) {
      gone.current = true;
      p.visible = false;
    }
    invalidate();
  });
  return (
    <group ref={g}>
      <mesh castShadow rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.34, 0.34, 0.12, 24]} />
        <meshStandardMaterial ref={mat} color={pal.settled} roughness={0.35} metalness={0.4} transparent opacity={1} />
      </mesh>
    </group>
  );
}

