export interface ComboCard {
  name: string;
}

export interface ComboUse {
  card: ComboCard;
  zoneLocations?: string[];
}

export interface ComboData {
  description?: string;
  uses: ComboUse[];
}

export interface CardImageUris {
  normal?: string;
}

export interface CardDetail {
  name: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  image_uris?: CardImageUris;
  combos: ComboData[];
}

export type HoverCardDetail = {
  x: number;
  y: number;
  data: CardDetail;
};

export type CardHoverHandler = (
  name: string,
  x: number,
  y: number,
  data: CardDetail
) => void;
