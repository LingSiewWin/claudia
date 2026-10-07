import type { Floor } from '../floor/model';
import type { CardView } from '../../lib/run';

export interface SceneProps {
  floor: Floor;
  selected: string | null;
  onSelect?: (id: string) => void;
  /** The cards behind the crates: the 3D courtyard reads bond and approval state the crate model does not carry. */
  cards?: CardView[];
  /** Vault balance after this run's settlements, formatted; null before RunStarted. */
  treasury?: string | null;
}
