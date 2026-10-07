import { describe, expect, it } from 'vitest';
import { wants3d } from '../components/floor3d/fallback';

describe('floor3d: when the 3D floor mounts', () => {
  it('mounts only with WebGL and without a reduced-motion preference', () => {
    expect(wants3d({ webgl: true, reducedMotion: false })).toBe(true);
    expect(wants3d({ webgl: false, reducedMotion: false })).toBe(false);
    expect(wants3d({ webgl: true, reducedMotion: true })).toBe(false);
    expect(wants3d({ webgl: false, reducedMotion: true })).toBe(false);
  });
});
