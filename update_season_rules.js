import fs from 'fs';

const ships = JSON.parse(fs.readFileSync('atxxii_all_ships.json', 'utf8'));

const code = `// ATXXII Tournament Season Rules & Modular Ship Data
// Official data ingested directly from CCP's ATXXII Comp Calculator Google Sheet
// Source: https://docs.google.com/spreadsheets/d/1zApPKi3PY5SPFW0aCzaLeTUzgS0bDfKxSChmP6s6xfE

export const ATXXII_CONFIG = {
  tournament: 'Alliance Tournament XXII',
  year: 2026,
  maxPoints: 200,
  banRules: {
    bansPerTeam: 3,
    banOrder: ['TEAM_A', 'TEAM_B', 'TEAM_B', 'TEAM_A', 'TEAM_A', 'TEAM_B'], // Serpentine A -> B -> B -> A -> A -> B
    turnTimeSeconds: 30,
    allowDuplicateBans: false,
    flagshipsBannable: false, // Flagships cannot be banned under official AT rules
  },
  scrimRules: {
    warmupDurationSeconds: 60,
    scrimDurationSeconds: 600, // 10 minutes
    maxPlayersPerTeam: 10,
  }
};

// Official ATXXII Ship Pool (${ships.length} ships with official EVE Image URLs)
export const TOURNAMENT_SHIP_POOL = ${JSON.stringify(ships, null, 2)};

// Validation helper
export function isShipBannable(shipId, currentBans = [], designatedFlagshipIds = []) {
  const ship = TOURNAMENT_SHIP_POOL.find(s => s.id === shipId);
  if (!ship) return { allowed: false, reason: 'Ship not found in tournament pool' };

  if (designatedFlagshipIds.includes(shipId) || ship.isFlagship) {
    return { allowed: false, reason: 'Flagships cannot be banned under Alliance Tournament rules' };
  }

  if (!ATXXII_CONFIG.banRules.allowDuplicateBans && currentBans.includes(shipId)) {
    return { allowed: false, reason: \`\${ship.name} has already been banned\` };
  }

  return { allowed: true, ship };
}

// Eligible Flagships helper: Battleships in tournament pool
export function getEligibleFlagships() {
  return TOURNAMENT_SHIP_POOL.filter(s => s.hullSize === 'Battleship');
}
`;

fs.writeFileSync('src/data/seasonRules.js', code);
console.log(`Successfully generated src/data/seasonRules.js with ${ships.length} ships and official EVE image URLs.`);
