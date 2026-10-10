export type UpgradeType = 'meleeDmg' | 'meleeHp' | 'rangedDmg'

export interface UpgradeDef {
  name: string
  cost: { gold: number; wood: number }
  maxLevel: number
  building: 'barracks' | 'archery' // Which building researches it
}

export const UPGRADES: Record<UpgradeType, UpgradeDef> = {
  meleeDmg: { name: 'Weapon Upgrade', cost: { gold: 100, wood: 50 }, maxLevel: 3, building: 'barracks' },
  meleeHp: { name: 'Armor Upgrade', cost: { gold: 100, wood: 50 }, maxLevel: 3, building: 'barracks' },
  rangedDmg: { name: 'Ranged Weapons', cost: { gold: 100, wood: 50 }, maxLevel: 3, building: 'archery' },
}

/** Bonus damage per level */
export const DMG_BONUS = 3
/** Bonus HP per level */
export const HP_BONUS = 25
