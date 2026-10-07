'use client';
import { Component, type ComponentType, type ReactNode, useEffect, useState } from 'react';
import { Scene as SvgScene } from '../floor/scene';
import type { SceneProps } from './types';
import { detectFloorEnv, wants3d } from './fallback';

type Floor3DComponent = ComponentType<SceneProps>;

/**
 * The floor scene: the 3D floor once its bundle has loaded, the SVG floor before that and whenever WebGL is missing,
 * the viewer prefers reduced motion, or the 3D scene throws. The server always renders the SVG.
 */
export function Scene(props: SceneProps) {
  const [Floor3D, setFloor3D] = useState<Floor3DComponent | null>(null);
  useEffect(() => {
    if (!wants3d(detectFloorEnv())) return;
    let live = true;
    import('./Floor3D').then((m) => live && setFloor3D(() => m.Floor3D)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!Floor3D) return <SvgScene {...props} />;
  return (
    <SceneBoundary fallback={<SvgScene {...props} />}>
      <Floor3D {...props} />
    </SceneBoundary>
  );
}

class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
