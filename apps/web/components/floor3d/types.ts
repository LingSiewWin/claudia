import type { Floor } from '../floor/model';

export interface SceneProps {
  floor: Floor;
  selected: string | null;
  onSelect?: (id: string) => void;
}
