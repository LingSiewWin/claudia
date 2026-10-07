'use client';
import { Float, Grid, Html, Line, OrbitControls, RoundedBox } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';

type OrbitControlsImpl = NonNullable<React.ComponentRef<typeof OrbitControls>>;
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Crate, Floor, Station } from '../floor/model';
import { type Palette, fallbackPalette, readPalette } from './palette';
import type { SceneProps } from './types';

/*
 * The authority floor in 3D: an isometric orthographic camera over a paper slab, one low-poly building per station and
 * one crate per action. The scene only draws when something changed (frameloop="demand"): a crate still travelling, a
 * beam sweeping, a card floating, or the camera moving. Idle costs nothing.
 */
// ponytail: one mesh per crate; a run has under ten. Instance them if a floor ever shows more than ~40.

const ISO = new THREE.Vector3(14, 14, 14);
const TARGET: [number, number, number] = [0.4, 2.6, 1.2];
/** World units across the fitted view; the seven stations span about 20. */
const VIEW_UNITS = 31;
const AZIMUTH = Math.PI / 4;
const POLAR = Math.acos(1 / Math.sqrt(3));
const TILT = THREE.MathUtils.degToRad(15);

/** Station i stands at (3.8i, 0, -1.2i) centred on the escrow: a gentle diagonal on screen, like the SVG floor. */
const AT: Record<Exclude<Station, 'sink'>, [number, number]> = {
  agent: [-11.4, 3.6],
  gate: [-7.6, 2.4],
  tower: [-3.8, 1.2],
  escrow: [0, 0],
  desk: [3.8, -1.2],
  vault: [7.6, -2.4],
  ledger: [11.4, -3.6],
};
const SINK: [number, number] = [2.4, 4.6];
const DOCK_Z = 2.3;
const DOCK_Z_PIN = DOCK_Z;
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
/** Where each station's label pin floats: above the roof, staggered so neighbours on the diagonal never overlap. */
const PIN_AT: Record<Station, [number, number, number]> = {
  agent: [AT.agent[0] - 1.6, 2.2, AT.agent[1] + 1.6],
  gate: [AT.gate[0], 4.3, AT.gate[1] + DOCK_Z_PIN],
  tower: [AT.tower[0], 5.6, AT.tower[1]],
  escrow: [AT.escrow[0], 2.9, AT.escrow[1]],
  sink: [SINK[0] + 1.2, 1.9, SINK[1] + 1.2],
  desk: [AT.desk[0], 2.6, AT.desk[1]],
  vault: [AT.vault[0], 3.9, AT.vault[1]],
  ledger: [AT.ledger[0], 2.6, AT.ledger[1]],
};
/** Crates rest in front of their building (toward the viewer); the lane runs through the gate's arch. */
const CRATE = 0.9;

function dockOf(c: Crate): [number, number] {
  if (c.station === 'sink') return [SINK[0], SINK[1] + 0.2];
  const [x, z] = AT[c.station];
  if (c.station === 'agent' && c.bounced) return [x - 2.1, z + DOCK_Z + 0.9];
  return [x, z + DOCK_Z];
}

function crateColor(c: Crate, p: Palette): string {
  if (c.tone === 'forbid') return c.station === 'sink' ? p.captured : p.denied;
  if (c.tone === 'permit') return p.settled;
  if (c.tone === 'cosign') return c.station === 'escrow' ? p.bond : p.escalated;
  return p.proposed;
}

export function Floor3D({ floor, selected, onSelect }: SceneProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const controls = useRef<OrbitControlsImpl>(null);
  const [pal, setPal] = useState<Palette>(fallbackPalette);
  const [base, setBase] = useState(40);
  useLayoutEffect(() => {
    const el = wrap.current?.closest('.floor') ?? wrap.current;
    if (el) setPal(readPalette(el));
  }, []);
  return (
    <div ref={wrap} data-testid="floor-3d" className="floor-3d">
      <Canvas
        orthographic
        shadows
        flat
        frameloop="demand"
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true }}
        camera={{ position: ISO.clone().add(new THREE.Vector3(...TARGET)).toArray(), zoom: base, near: 0.1, far: 120 }}
      >
        <Fit onFit={setBase} controls={controls} />
        <OrbitControls
          ref={controls}
          makeDefault
          target={TARGET}
          enablePan={false}
          enableDamping={false}
          minAzimuthAngle={AZIMUTH - TILT}
          maxAzimuthAngle={AZIMUTH + TILT}
          minPolarAngle={POLAR - TILT / 3}
          maxPolarAngle={POLAR + TILT / 3}
          minZoom={base * 0.75}
          maxZoom={base * 1.8}
          rotateSpeed={0.5}
          zoomSpeed={0.6}
        />
        <Lights pal={pal} />
        <Ground pal={pal} />
        <Stations floor={floor} pal={pal} />
        {floor.crates.map((c, i) => (
          <CrateMesh key={c.id} crate={c} slot={slotOf(floor.crates, i)} pal={pal} selected={selected === c.id} onSelect={onSelect ?? null} />
        ))}
        <Ticker floor={floor} />
      </Canvas>
      <button type="button" className="floor-reset" onClick={() => controls.current?.reset()}>
        Reset view
      </button>
    </div>
  );
}

/** Zoom so the stations fill the width, whatever the container size; remembered as the view "Reset view" returns to. */
function Fit({ onFit, controls }: { onFit: (zoom: number) => void; controls: React.RefObject<OrbitControlsImpl | null> }) {
  const { camera, size, invalidate } = useThree();
  useLayoutEffect(() => {
    const zoom = size.width / VIEW_UNITS;
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    onFit(zoom);
    controls.current?.saveState();
    invalidate();
  }, [camera, size.width, onFit, controls, invalidate]);
  return null;
}

/** Keeps frames coming while something on the floor is animating on its own (beam, brief, glow). Crates request their own. */
function Ticker({ floor }: { floor: Floor }) {
  const st = floor.stations;
  const alive = st.tower === 'scanning' || st.desk !== null || st.vault === 'releasing';
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
      <hemisphereLight args={['#ffffff', pal.warm2, 1.15]} />
      <directionalLight
        color="#fff3e2"
        intensity={2.6}
        position={[6, 11, 10]}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={14}
        shadow-camera-bottom={-14}
        shadow-camera-near={1}
        shadow-camera-far={60}
      />
    </>
  );
}

function Ground({ pal }: { pal: Palette }) {
  const lane = useMemo(() => {
    return (['agent', 'gate', 'tower', 'escrow', 'desk', 'vault', 'ledger'] as const).map((s) => {
      const [x, z] = AT[s];
      return new THREE.Vector3(x, 0.02, z + DOCK_Z);
    });
  }, []);
  const sinkLane = useMemo(() => [new THREE.Vector3(AT.escrow[0], 0.02, AT.escrow[1] + DOCK_Z), new THREE.Vector3(SINK[0], 0.02, SINK[1])], []);
  return (
    <group>
      <RoundedBox args={[32, 0.5, 15]} radius={0.18} smoothness={3} position={[0, -0.25, 0.9]} receiveShadow>
        <meshStandardMaterial color={pal.paper} roughness={1} />
      </RoundedBox>
      <Grid
        position={[0, 0.003, 0.9]}
        args={[32, 15]}
        cellSize={1}
        cellThickness={0.7}
        cellColor={pal.grid}
        sectionSize={4}
        sectionThickness={1.1}
        sectionColor={pal.grid}
        fadeDistance={80}
        fadeStrength={0}
        infiniteGrid={false}
      />
      <Line points={lane} color={pal.warm2} lineWidth={1.2} dashed dashSize={0.3} gapSize={0.25} />
      <Line points={sinkLane} color={pal.warm2} lineWidth={1.2} dashed dashSize={0.3} gapSize={0.25} />
    </group>
  );
}

function Block({
  size,
  at,
  color,
  radius = 0.08,
}: {
  size: [number, number, number];
  /** Centre on x and z, base on y. */
  at: [number, number, number];
  color: string;
  radius?: number;
}) {
  return (
    <RoundedBox args={size} radius={radius} smoothness={3} position={[at[0], at[1] + size[1] / 2, at[2]]} castShadow receiveShadow>
      <meshStandardMaterial color={color} roughness={0.9} />
    </RoundedBox>
  );
}

function Pin({ station, count, state, testid, children }: { station: Station; count?: number | string; state?: string; testid?: string; children?: React.ReactNode }) {
  const [x, y, z] = PIN_AT[station];
  return (
    <Html position={[x, y, z]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
      <span className="floor-pin" data-testid={testid} data-state={state}>
        {LABEL[station]}
        {count !== undefined ? <b>{count}</b> : null}
        {children}
      </span>
    </Html>
  );
}

function Lamp({ at, color, on = true }: { at: [number, number, number]; color: string; on?: boolean }) {
  return (
    <mesh position={at}>
      <sphereGeometry args={[0.17, 20, 20]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={on ? 0.9 : 0} roughness={0.4} />
    </mesh>
  );
}

function Stations({ floor, pal }: { floor: Floor; pal: Palette }) {
  const st = floor.stations;
  const crates = floor.crates;
  const atAgent = crates.filter((c) => c.station === 'agent').length;
  const lampOf = (d: typeof st.gate) => (d === 'ALLOW' ? pal.permit : d === 'ESCALATE' ? pal.cosign : d === 'DENY' ? pal.forbid : '#b9b3aa');
  const approval = floor.selected?.approval?.status ?? null;
  const deskLamp = approval === 'approved' ? pal.permit : approval === 'declined' ? pal.forbid : approval === 'pending' ? pal.cosign : '#b9b3aa';
  const [ax, az] = AT.agent;
  const [gx, gz] = AT.gate;
  const [tx, tz] = AT.tower;
  const [ex, ez] = AT.escrow;
  const [dx, dz] = AT.desk;
  const [vx, vz] = AT.vault;
  const [lx, lz] = AT.ledger;
  return (
    <group>
      {/* agent depot: low studio, small roof box, an antenna */}
      <Block size={[2.4, 1.5, 2.2]} at={[ax, 0, az]} color={pal.tint2} radius={0.14} />
      <Block size={[1.0, 0.5, 1.0]} at={[ax - 0.4, 1.5, az - 0.3]} color={pal.tint3} />
      <mesh position={[ax + 0.8, 2.1, az + 0.6]} castShadow>
        <cylinderGeometry args={[0.03, 0.03, 1.2, 8]} />
        <meshStandardMaterial color={pal.ink} />
      </mesh>
      <Lamp at={[ax + 0.8, 2.75, az + 0.6]} color={pal.tint4} />
      <Pin station="agent" count={atAgent} />

      {/* authority engine: an arch across the lane; the lamp shows the last decision */}
      <Block size={[0.7, 2.8, 0.7]} at={[gx, 0, gz + DOCK_Z - 1.2]} color={pal.tint4} />
      <Block size={[0.7, 2.8, 0.7]} at={[gx, 0, gz + DOCK_Z + 1.2]} color={pal.tint4} />
      <Block size={[1.0, 0.55, 3.4]} at={[gx, 2.8, gz + DOCK_Z]} color={pal.ink} radius={0.1} />
      <Lamp at={[gx + 0.55, 3.1, gz + DOCK_Z]} color={lampOf(st.gate)} on={st.gate !== 'idle'} />
      <Pin station="gate" state={st.gate} testid="floor-gate">
        {st.gate !== 'idle' ? <b>{st.gate}</b> : null}
      </Pin>

      {/* chainlink cre tower: tall, with a scan cone over its dock while verifying */}
      <Block size={[2.4, 0.5, 2.4]} at={[tx, 0, tz]} color={pal.tint1} radius={0.12} />
      <Block size={[1.3, 3.6, 1.3]} at={[tx, 0.5, tz]} color={pal.tint3} radius={0.12} />
      <Block size={[1.7, 0.5, 1.7]} at={[tx, 4.1, tz]} color={pal.ink} radius={0.1} />
      <Beam at={[tx, 4.4, tz]} toward={[tx, 0, tz + DOCK_Z]} color={pal.tint4} active={st.tower === 'scanning'} />
      <Pin station="tower" state={st.tower} testid="floor-beam" />

      {/* bond escrow: a strongbox; the lid closes and coins stack while bonds are locked */}
      <Block size={[2.4, 1.6, 2.2]} at={[ex, 0, ez]} color={st.escrow.locked > 0 ? pal.tint4 : pal.tint2} radius={0.14} />
      <Lid at={[ex, 1.6, ez - 1.1]} size={[2.4, 0.3, 2.2]} color={st.escrow.locked > 0 ? pal.tint3 : pal.tint1} closed={st.escrow.locked > 0} />
      {Array.from({ length: Math.min(st.escrow.locked, 4) }, (_, i) => (
        <mesh key={i} position={[ex - 0.5 + (i % 2) * 1.0, 2.0 + Math.floor(i / 2) * 0.16, ez + 0.3]} castShadow>
          <cylinderGeometry args={[0.32, 0.32, 0.14, 24]} />
          <meshStandardMaterial color={pal.bond} roughness={0.5} metalness={0.2} />
        </mesh>
      ))}
      <Pin station="escrow" count={st.escrow.locked} />

      {/* sink: a shallow pit for captured bonds */}
      <Block size={[2.4, 0.16, 2.2]} at={[SINK[0], 0, SINK[1]]} color={pal.warm2} radius={0.06} />
      <mesh position={[SINK[0], 0.17, SINK[1]]} receiveShadow>
        <boxGeometry args={[1.8, 0.02, 1.6]} />
        <meshStandardMaterial color={pal.ink} roughness={1} />
      </mesh>
      <Pin station="sink" count={st.escrow.captured} />

      {/* human desk: a small office; the brief floats above it while a human is being asked */}
      <Block size={[2.4, 1.1, 1.6]} at={[dx, 0, dz - 0.3]} color={pal.warm1} radius={0.12} />
      <Block size={[2.6, 0.3, 1.8]} at={[dx, 1.1, dz - 0.3]} color={pal.tint3} radius={0.1} />
      <Block size={[0.7, 0.5, 0.5]} at={[dx - 0.4, 0, dz + 0.9]} color={pal.tint1} />
      <Lamp at={[dx + 1.0, 1.6, dz + 0.5]} color={deskLamp} on={approval !== null} />
      <Brief at={[dx, 2.2, dz]} open={st.desk !== null} color={pal.cosign} paper={pal.paper} />
      <Pin station="desk" state={st.desk ? 'open' : 'idle'} testid="floor-brief" />

      {/* treasury vault: the heaviest building; the door slides open and the floor glows while it settles */}
      <Block size={[2.8, 2.6, 2.8]} at={[vx, 0, vz]} color={st.vault === 'rejected' ? pal.denied : pal.vault} radius={0.18} />
      <Door at={[vx, 0.1, vz + 1.42]} open={st.vault === 'releasing'} color={pal.tint4} />
      <Glow at={[vx, 0.03, vz + DOCK_Z]} color={pal.glow} on={st.vault === 'releasing'} />
      <Pin station="vault" state={st.vault} testid="floor-vault">
        {st.vault !== 'idle' ? <b>{st.vault}</b> : null}
      </Pin>

      {/* receipts: the ledger grows a sheet per proven action */}
      <Block size={[2.4, 1.0, 2.2]} at={[lx, 0, lz]} color={pal.warm2} radius={0.12} />
      {Array.from({ length: Math.min(st.ledger, 8) }, (_, i) => (
        <Block key={i} size={[1.5, 0.11, 1.2]} at={[lx, 1.0 + i * 0.13, lz]} color="#ffffff" radius={0.02} />
      ))}
      <Pin station="ledger" count={st.ledger} />
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

function Beam({ at, toward, color, active }: { at: [number, number, number]; toward: [number, number, number]; color: string; active: boolean }) {
  const group = useRef<THREE.Group>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const on = useEase(active ? 1 : 0, 5);
  const h = Math.hypot(toward[0] - at[0], toward[1] - at[1], toward[2] - at[2]);
  const tilt = -Math.atan2(toward[2] - at[2], at[1] - toward[1]);
  const geom = useMemo(() => new THREE.ConeGeometry(1.25, h, 28, 1, true).translate(0, -h / 2, 0), [h]);
  useFrame(({ clock }) => {
    if (!group.current || !mat.current) return;
    const t = clock.getElapsedTime();
    group.current.rotation.z = active ? Math.sin(t * 2.2) * 0.07 : 0;
    mat.current.opacity = on.current * (0.22 + (active ? (Math.sin(t * 3) + 1) * 0.08 : 0));
  });
  return (
    <group ref={group} position={at} rotation={[tilt, 0, 0]}>
      <mesh geometry={geom}>
        <meshBasicMaterial ref={mat} color={color} transparent opacity={0} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Lid({ at, size, color, closed }: { at: [number, number, number]; size: [number, number, number]; color: string; closed: boolean }) {
  const g = useRef<THREE.Group>(null);
  const angle = useEase(closed ? 0 : -0.8, 6);
  useFrame(() => {
    if (g.current) g.current.rotation.x = angle.current;
  });
  return (
    <group ref={g} position={at}>
      <RoundedBox args={size} radius={0.08} smoothness={3} position={[0, size[1] / 2, size[2] / 2]} castShadow receiveShadow>
        <meshStandardMaterial color={color} roughness={0.9} />
      </RoundedBox>
    </group>
  );
}

function Brief({ at, open, color, paper }: { at: [number, number, number]; open: boolean; color: string; paper: string }) {
  const g = useRef<THREE.Group>(null);
  const rise = useEase(open ? 1 : 0, 6);
  useFrame(() => {
    if (!g.current) return;
    g.current.scale.setScalar(Math.max(0.001, rise.current));
    g.current.visible = rise.current > 0.01;
  });
  return (
    <group ref={g} position={at}>
      <Float speed={open ? 2 : 0} rotationIntensity={0.15} floatIntensity={0.6}>
        <group rotation={[-0.35, Math.PI / 4, 0]}>
          <mesh castShadow>
            <boxGeometry args={[1.1, 0.75, 0.04]} />
            <meshStandardMaterial color={paper} roughness={0.95} />
          </mesh>
          {[0.2, 0.06, -0.08].map((y, i) => (
            <mesh key={i} position={[-0.12 + i * 0.05, y, 0.025]}>
              <boxGeometry args={[0.66 - i * 0.18, 0.05, 0.01]} />
              <meshStandardMaterial color="#8a8378" />
            </mesh>
          ))}
          <mesh position={[0.32, -0.22, 0.03]}>
            <boxGeometry args={[0.26, 0.12, 0.02]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
          </mesh>
        </group>
      </Float>
    </group>
  );
}

function Door({ at, open, color }: { at: [number, number, number]; open: boolean; color: string }) {
  const m = useRef<THREE.Mesh>(null);
  const slide = useEase(open ? 1 : 0, 5);
  useFrame(() => {
    if (m.current) m.current.position.x = at[0] - slide.current * 1.25;
  });
  return (
    <mesh ref={m} position={[at[0], at[1] + 0.85, at[2]]} castShadow>
      <boxGeometry args={[1.3, 1.7, 0.12]} />
      <meshStandardMaterial color={color} roughness={0.6} metalness={0.15} />
    </mesh>
  );
}

function Glow({ at, color, on }: { at: [number, number, number]; color: string; on: boolean }) {
  const light = useRef<THREE.PointLight>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const k = useEase(on ? 1 : 0, 4);
  useFrame(({ clock }) => {
    const pulse = on ? 0.85 + Math.sin(clock.getElapsedTime() * 3) * 0.15 : 1;
    if (light.current) light.current.intensity = k.current * pulse * 14;
    if (mat.current) mat.current.opacity = k.current * pulse * 0.45;
  });
  return (
    <group position={at}>
      <pointLight ref={light} color={color} intensity={0} distance={7} decay={2} position={[0, 1.4, 0]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.9, 40]} />
        <meshBasicMaterial ref={mat} color={color} transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Pile slot of crate i: piles are three high, then a new column beside the pile. */
function slotOf(crates: Crate[], i: number): [number, number] {
  const c = crates[i]!;
  let k = 0;
  for (let j = 0; j < i; j++) {
    const o = crates[j]!;
    if (o.station === c.station && o.bounced === c.bounced) k++;
  }
  return [Math.floor(k / 3), k % 3];
}

function CrateMesh({ crate, slot, pal, selected, onSelect }: { crate: Crate; slot: [number, number]; pal: Palette; selected: boolean; onSelect: ((id: string) => void) | null }) {
  const g = useRef<THREE.Group>(null);
  const [hover, setHover] = useState(false);
  const { invalidate } = useThree();
  const [dx, dz] = dockOf(crate);
  const target = useMemo(() => new THREE.Vector3(dx - slot[0] * (CRATE + 0.25), slot[1] * (CRATE + 0.02) + CRATE / 2, dz), [dx, dz, slot]);
  const travel = useRef({ total: 0, hop: 0.6 });
  const first = useRef(true);
  useEffect(() => {
    if (!g.current) return;
    if (first.current) {
      first.current = false;
      g.current.position.copy(target);
      invalidate();
      return;
    }
    travel.current = { total: g.current.position.distanceTo(target), hop: crate.bounced ? 1.8 : 0.6 };
    invalidate();
  }, [target, crate.bounced, invalidate]);
  useFrame((_, dt) => {
    const p = g.current;
    if (!p) return;
    const d = p.position.distanceTo(target);
    if (d < 0.004) {
      p.position.copy(target);
      p.rotation.set(0, 0, 0);
      return;
    }
    const k = Math.min(1, dt * 4.5);
    p.position.x += (target.x - p.position.x) * k;
    p.position.z += (target.z - p.position.z) * k;
    const { total, hop } = travel.current;
    const frac = total > 0 ? Math.min(1, p.position.distanceTo(target) / total) : 0;
    p.position.y = target.y + Math.sin(frac * Math.PI) * hop;
    p.rotation.y = Math.sin(frac * Math.PI) * (crate.bounced ? 0.5 : 0.15);
    invalidate();
  });
  const color = crateColor(crate, pal);
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
      <RoundedBox args={[CRATE, CRATE, CRATE]} radius={0.09} smoothness={3} castShadow receiveShadow scale={selected || hover ? 1.08 : 1}>
        <meshStandardMaterial color={color} roughness={0.85} emissive={color} emissiveIntensity={hover ? 0.25 : selected ? 0.12 : 0} transparent={crate.bounced} opacity={crate.bounced ? 0.88 : 1} />
      </RoundedBox>
      <mesh position={[0, CRATE / 2 + 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.16, CRATE * 0.98]} />
        <meshStandardMaterial color={pal.ink} transparent opacity={0.4} />
      </mesh>
      {selected ? (
        <mesh position={[0, -CRATE / 2 + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.72, 0.86, 40]} />
          <meshBasicMaterial color={pal.ink} />
        </mesh>
      ) : null}
      <Html center zIndexRange={[4, 0]} position={[0, 0, 0]}>
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
