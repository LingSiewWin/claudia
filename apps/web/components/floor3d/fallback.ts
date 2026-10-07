/** Whether the 3D floor should mount. Pure, so the decision is testable without a browser. */
export interface FloorEnv {
  webgl: boolean;
  reducedMotion: boolean;
}

export function wants3d(env: FloorEnv): boolean {
  return env.webgl && !env.reducedMotion;
}

/** Feature-detect in the browser. Any failure counts as "no WebGL": the SVG floor is always safe. */
export function detectFloorEnv(): FloorEnv {
  let webgl = false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    webgl = gl !== null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl = false;
  }
  let reducedMotion = false;
  try {
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    reducedMotion = false;
  }
  return { webgl, reducedMotion };
}
