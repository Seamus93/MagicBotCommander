export interface CreatureBlueprint {
  name: string;
  power: number;
  toughness: number;
  manaCost: number;
}

export interface CreaturePermanent {
  id: string;
  name: string;
  power: number;
  toughness: number;
  tapped: boolean;
  summoningSickness: boolean;
  keywords?: string[];
}
