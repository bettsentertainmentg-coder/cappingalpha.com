// modules/esports.js — Esports tab

const ESPORTS_GAMES = [
  { rank: 1,  name: 'Rainbow Six Siege',   short: 'R6S',  genre: 'Tactical FPS',  grad: 'linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%)',   icon: 'fa-solid fa-crosshairs',      color: '#38bdf8' },
  { rank: 2,  name: 'Counter-Strike 2',    short: 'CS2',  genre: 'Tactical FPS',  grad: 'linear-gradient(135deg,#1c1c1c 0%,#2d2d2d 40%,#f5a623 100%)',   icon: 'fa-solid fa-bomb',            color: '#f5a623' },
  { rank: 3,  name: 'Valorant',            short: 'VAL',  genre: 'Tactical FPS',  grad: 'linear-gradient(135deg,#1a0a0a 0%,#3d0b0b 50%,#ff4655 100%)',   icon: 'fa-solid fa-gun',             color: '#ff4655' },
  { rank: 4,  name: 'League of Legends',   short: 'LoL',  genre: 'MOBA',          grad: 'linear-gradient(135deg,#0a1628 0%,#091428 50%,#c8aa6e 100%)',   icon: 'fa-solid fa-shield-halved',   color: '#c8aa6e' },
  { rank: 5,  name: 'Dota 2',             short: 'DOTA', genre: 'MOBA',          grad: 'linear-gradient(135deg,#0d0d0d 0%,#1a1a1a 50%,#c23c2a 100%)',   icon: 'fa-solid fa-dragon',          color: '#c23c2a' },
  { rank: 6,  name: 'Overwatch 2',        short: 'OW2',  genre: 'Hero Shooter',  grad: 'linear-gradient(135deg,#0a1f3d 0%,#0d2951 50%,#f99e1a 100%)',   icon: 'fa-solid fa-user-astronaut',  color: '#f99e1a' },
  { rank: 7,  name: 'Rocket League',      short: 'RL',   genre: 'Sports',        grad: 'linear-gradient(135deg,#0a1628 0%,#1a3d6e 50%,#5b9bd5 100%)',   icon: 'fa-solid fa-car',             color: '#5b9bd5' },
  { rank: 8,  name: 'Call of Duty',       short: 'CDL',  genre: 'FPS',           grad: 'linear-gradient(135deg,#0d1117 0%,#1c2431 50%,#4a5568 100%)',   icon: 'fa-solid fa-skull',           color: '#718096' },
  { rank: 9,  name: 'Apex Legends',       short: 'APEX', genre: 'Battle Royale', grad: 'linear-gradient(135deg,#0d1117 0%,#1a1a2e 50%,#cd4400 100%)',   icon: 'fa-solid fa-fire',            color: '#cd4400' },
  { rank: 10, name: 'PUBG Esports',       short: 'PUBG', genre: 'Battle Royale', grad: 'linear-gradient(135deg,#0a1628 0%,#1c3a5e 50%,#f5c518 100%)',   icon: 'fa-solid fa-circle-dot',      color: '#f5c518' },
];

export function renderEsports() {
  const grid = document.getElementById('esports-grid');
  if (!grid) return;

  grid.innerHTML = ESPORTS_GAMES.map(g => `
    <div class="esports-card" style="background:${g.grad};">
      <div class="esports-card-rank"># ${g.rank}</div>
      <div style="font-size:22px;margin-bottom:8px;color:${g.color};"><i class="${g.icon}"></i></div>
      <div class="esports-card-name">${g.name}</div>
      <div class="esports-card-sub">${g.genre} &middot; ${g.short}</div>
      <span class="esports-card-badge">Coming Soon</span>
    </div>`).join('');
}
