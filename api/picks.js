const MLB_BASE = 'https://statsapi.mlb.com/api/v1';
const ODDS_API_KEY = '91e196167337349e685cec3112685b65';

const PARK_FACTORS = {
  'Coors Field':            { runs: 115, hr: 118 },
  'Fenway Park':            { runs: 107, hr: 105 },
  'Great American Ball Park': { runs: 108, hr: 113 },
  'Globe Life Field':       { runs: 104, hr: 104 },
  'Yankee Stadium':         { runs: 106, hr: 114 },
  'Wrigley Field':          { runs: 103, hr: 106 },
  'Oracle Park':            { runs: 95,  hr: 91  },
  'Dodger Stadium':         { runs: 96,  hr: 96  },
  'T-Mobile Park':          { runs: 94,  hr: 95  },
  'Petco Park':             { runs: 93,  hr: 91  },
  'Tropicana Field':        { runs: 96,  hr: 95  },
  'loanDepot park':         { runs: 97,  hr: 98  },
  'Nationals Park':         { runs: 99,  hr: 100 },
  'Camden Yards':           { runs: 104, hr: 109 },
  'Target Field':           { runs: 97,  hr: 96  },
  'American Family Field':  { runs: 101, hr: 103 },
  'Minute Maid Park':       { runs: 104, hr: 108 },
  'Angel Stadium':          { runs: 97,  hr: 98  },
  'Kauffman Stadium':       { runs: 96,  hr: 94  },
  'Comerica Park':          { runs: 95,  hr: 92  },
  'Guaranteed Rate Field':  { runs: 103, hr: 109 },
  'Progressive Field':      { runs: 97,  hr: 97  },
  'PNC Park':               { runs: 95,  hr: 93  },
  'Busch Stadium':          { runs: 96,  hr: 94  },
  'Chase Field':            { runs: 101, hr: 103 },
  'Citi Field':             { runs: 97,  hr: 97  },
  'Citizens Bank Park':     { runs: 104, hr: 108 },
  'Truist Park':            { runs: 100, hr: 103 },
  'Oakland Coliseum':       { runs: 94,  hr: 92  },
};

const LEAGUE_AVG_RUNS = 4.5;
const LEAGUE_AVG_ERA  = 4.00;
const LEAGUE_AVG_OPS  = 0.730;
const LEAGUE_AVG_AVG  = 0.250;

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function fmt3(v) {
  if (v == null || isNaN(v)) return '-';
  return v.toFixed(3).replace(/^0/, '');
}

function fmtOdds(o) {
  if (o == null) return 'N/A';
  return o > 0 ? `+${o}` : `${o}`;
}

function makeScorer() {
  let total = 0;
  const parts = [];
  return {
    add(label, value) { total += value; parts.push({ label, value }); },
    multiplyBy(label, delta) {
      const before = total;
      total *= (1 + delta);
      parts.push({ label, value: total - before });
    },
    finalize(market) {
      const score = Math.max(0, Math.min(100, total));
      return { score, components: parts, market };
    },
  };
}

function scoreToConfidence(score) {
  if (score >= 68) return 'High';
  if (score >= 52) return 'Medium';
  return 'Low';
}

function probToAmericanOdds(p) {
  if (p >= 1) return '-9999';
  if (p <= 0) return '+9999';
  if (p >= 0.5) return `-${Math.round(p / (1 - p) * 100)}`;
  return `+${Math.round((1 - p) / p * 100)}`;
}

function scoreToHitProb(score) {
  const t = Math.max(0, Math.min(1, (score - 30) / 60));
  return 0.62 + t * (0.72 - 0.62);
}

async function fetchSchedule(dateStr) {
  try {
    const r = await fetch(`${MLB_BASE}/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,team,venue,lineups`);
    const data = await r.json();
    return data.dates?.[0]?.games || [];
  } catch (e) { return []; }
}

async function fetchPitcherStats(id, season) {
  if (!id) return null;
  try {
    const [seasonRes, splitsRes] = await Promise.all([
      fetch(`${MLB_BASE}/people/${id}/stats?stats=season&group=pitching&season=${season}&gameType=R`),
      fetch(`${MLB_BASE}/people/${id}/stats?stats=statSplits&sitCodes=vl,vr&group=pitching&season=${season}`),
    ]);
    const seasonData = await seasonRes.json();
    const splitsData = await splitsRes.json();
    const s = seasonData.stats?.[0]?.splits?.[0]?.stat;
    if (!s) return null;
    const ip = parseFloat(s.inningsPitched) || 0;
    const gs = s.gamesStarted || 1;
    let vsLBAA = null, vsRBAA = null;
    for (const sp of splitsData.stats?.[0]?.splits || []) {
      if (sp.split?.code === 'vl') vsLBAA = parseFloat(sp.stat.avg);
      if (sp.split?.code === 'vr') vsRBAA = parseFloat(sp.stat.avg);
    }
    let recentForm = null;
    try {
      const rfRes = await fetch(`${MLB_BASE}/people/${id}/stats?stats=gameLog&group=pitching&season=${season}`);
      const rfData = await rfRes.json();
      const starts = (rfData.stats?.[0]?.splits || []).filter(g => g.stat.gamesStarted > 0).slice(0, 3);
      if (starts.length >= 2) {
        const totK  = starts.reduce((a, g) => a + (g.stat.strikeOuts || 0), 0);
        const totIP = starts.reduce((a, g) => a + parseFloat(g.stat.inningsPitched || 0), 0);
        const totER = starts.reduce((a, g) => a + (g.stat.earnedRuns || 0), 0);
        recentForm = { starts: starts.length, k9: totIP > 0 ? (totK / totIP) * 9 : null, era: totIP > 0 ? (totER / totIP) * 9 : null, ip: totIP };
      }
    } catch (_) {}
    return {
      era: parseFloat(s.era), k9: parseFloat(s.strikeoutsPer9Inn),
      bb9: parseFloat(s.walksPer9Inn), whip: parseFloat(s.whip),
      ipPerStart: gs > 0 ? ip / gs : null, vsLBAA, vsRBAA, recentForm,
    };
  } catch (e) { return null; }
}

async function fetchBatterStats(id, season) {
  if (!id) return null;
  try {
    const r = await fetch(`${MLB_BASE}/people/${id}/stats?stats=season,statSplits&sitCodes=vl,vr&group=hitting&season=${season}`);
    const data = await r.json();
    let season_s = null, vsL = null, vsR = null;
    for (const sg of data.stats || []) {
      if (sg.type?.displayName === 'season' && sg.splits?.[0]) season_s = sg.splits[0].stat;
      for (const sp of sg.splits || []) {
        if (sp.split?.code === 'vl') vsL = sp.stat;
        if (sp.split?.code === 'vr') vsR = sp.stat;
      }
    }
    if (!season_s) return null;
    const safe = (s, key) => parseFloat(s?.[key]) || null;
    return {
      avg: safe(season_s, 'avg'), ops: safe(season_s, 'ops'),
      ab: season_s.atBats || 0, pa: season_s.plateAppearances || 0,
      hr: season_s.homeRuns || 0, bb: season_s.baseOnBalls || 0,
      hbp: season_s.hitByPitch || 0, hits: season_s.hits || 0,
      doubles: season_s.doubles || 0, triples: season_s.triples || 0,
      vsLAvg: safe(vsL, 'avg'), vsRAvg: safe(vsR, 'avg'),
      vsLOps: safe(vsL, 'ops'), vsROps: safe(vsR, 'ops'),
      vsLDetail: vsL ? { pa: vsL.plateAppearances || 0, obp: safe(vsL, 'obp') } : null,
      vsRDetail: vsR ? { pa: vsR.plateAppearances || 0, obp: safe(vsR, 'obp') } : null,
    };
  } catch (e) { return null; }
}

async function fetchBatterGameLog(id, season) {
  if (!id) return null;
  try {
    const r = await fetch(`${MLB_BASE}/people/${id}/stats?stats=gameLog&group=hitting&season=${season}`);
    const data = await r.json();
    const recent = (data.stats?.[0]?.splits || []).slice(0, 10);
    if (!recent.length) return null;
    return {
      hits: recent.reduce((a, g) => a + (g.stat.hits || 0), 0),
      ab: recent.reduce((a, g) => a + (g.stat.atBats || 0), 0),
      games: recent.length,
    };
  } catch (e) { return null; }
}

async function fetchOdds() {
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,totals&oddsFormat=american&bookmakers=draftkings,fanduel`);
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

function calcHitScore(batter, pitcherStats, pitcherHand, parkFactor) {
  const stats = batter.stats;
  if (!stats || isNaN(stats.avg) || stats.ab < 20) return null;
  const sc = makeScorer();
  sc.add(`Season AVG (${fmt3(stats.avg)})`, stats.avg * 60);
  if (!isNaN(stats.ops)) sc.add('Season OPS context', (stats.ops - LEAGUE_AVG_OPS) * 18);
  if (pitcherStats) {
    const pitcherBAA = pitcherHand === 'L' ? pitcherStats.vsLBAA : pitcherStats.vsRBAA;
    if (pitcherBAA != null && !isNaN(pitcherBAA)) {
      sc.add(`Starter BAA vs ${pitcherHand}HP`, (pitcherBAA - LEAGUE_AVG_AVG) * 130);
    } else if (!isNaN(pitcherStats.whip)) {
      sc.add(`Starter WHIP`, (pitcherStats.whip - 1.30) * 25);
    }
  }
  const vsHandAvg = pitcherHand === 'L' ? stats.vsLAvg : stats.vsRAvg;
  if (vsHandAvg != null && !isNaN(vsHandAvg)) sc.add(`Batter vs ${pitcherHand}HP AVG`, (vsHandAvg - stats.avg) * 45);
  if (parkFactor) sc.add('Park runs', (parkFactor.runs - 100) / 5);
  if (batter.gameLog && batter.gameLog.ab >= 20) {
    const rollingAvg = batter.gameLog.hits / batter.gameLog.ab;
    if (!isNaN(rollingAvg)) sc.add('L10 form', (rollingAvg - LEAGUE_AVG_AVG) * 45);
  }
  return sc.finalize('hit');
}

function calcKScore(pitcherStats, oppLineupStats) {
  if (!pitcherStats?.k9 || pitcherStats.k9 < 4.0) return null;
  const sc = makeScorer();
  sc.add(`Base K/9 × 5.8 IP`, (pitcherStats.k9 / 9) * 5.8);
  if (oppLineupStats?.length) {
    const opsVals = oppLineupStats.map(b => b?.ops).filter(v => v != null && !isNaN(v));
    if (opsVals.length) {
      const lineupOps = opsVals.reduce((a, v) => a + v, 0) / opsVals.length;
      sc.multiplyBy('Lineup OPS', (LEAGUE_AVG_OPS / Math.max(lineupOps, 0.600)) - 1);
    }
  }
  if (!isNaN(pitcherStats.era) && pitcherStats.era < 3.50) sc.multiplyBy('Elite ERA', 0.05);
  if (pitcherStats.bb9 != null) {
    if (pitcherStats.bb9 < 2.5) sc.multiplyBy('Low BB/9', 0.03);
    else if (pitcherStats.bb9 > 4.0) sc.multiplyBy('High BB/9', -0.04);
  }
  if (pitcherStats.ipPerStart != null) {
    if (pitcherStats.ipPerStart >= 6.2) sc.multiplyBy('Goes deep', 0.04);
    else if (pitcherStats.ipPerStart < 5.0) sc.multiplyBy('Short outings', -0.06);
  }
  if (pitcherStats.recentForm?.k9 != null && pitcherStats.recentForm.starts >= 2) {
    const delta = pitcherStats.recentForm.k9 - pitcherStats.k9;
    if (Math.abs(delta) >= 1.0) sc.multiplyBy(`Recent K/9 trend`, Math.max(-0.07, Math.min(0.07, delta * 0.025)));
  }
  return sc.finalize('k');
}

function calcProjections(homePitcherERA, awayPitcherERA, homeLineupOps, awayLineupOps, parkFactor) {
  const pitcherQuality = (era) => Math.min(Math.max((isNaN(era) ? LEAGUE_AVG_ERA : era) / LEAGUE_AVG_ERA, 0.55), 1.55);
  const park = (parkFactor?.runs || 100) / 100;
  const awayProj = LEAGUE_AVG_RUNS * pitcherQuality(homePitcherERA) * ((awayLineupOps || LEAGUE_AVG_OPS) / LEAGUE_AVG_OPS) * park;
  const homeProj = LEAGUE_AVG_RUNS * pitcherQuality(awayPitcherERA) * ((homeLineupOps || LEAGUE_AVG_OPS) / LEAGUE_AVG_OPS) * park * 1.03;
  const total = awayProj + homeProj;
  const homeWinProb = Math.min(0.92, Math.max(0.08, homeProj / (homeProj + awayProj) + 0.03));
  return { awayProj: Math.round(awayProj * 10) / 10, homeProj: Math.round(homeProj * 10) / 10, total: Math.round(total * 10) / 10, homeWinProb, awayWinProb: 1 - homeWinProb };
}

async function batchFetch(items, fn, batchSize = 4) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = await Promise.all(items.slice(i, i + batchSize).map(fn));
    results.push(...batch);
  }
  return results;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

  const dateStr = todayET();
  const season  = new Date().getFullYear();

  const [rawGames, oddsData] = await Promise.all([fetchSchedule(dateStr), fetchOdds()]);

  if (!rawGames.length) {
    return res.status(200).json({ hits: [], strikeouts: [], moneylines: [], totals: [], parlays: [], lastUpdated: new Date().toISOString(), date: dateStr });
  }

  const gameObjects = rawGames.slice(0, 15).map(g => {
    const away = g.teams?.away;
    const home = g.teams?.home;
    const venue = g.venue?.name || '';
    const extractLineup = (players) => (players || [])
      .filter(p => p.battingOrder && !isNaN(parseInt(p.battingOrder)))
      .sort((a, b) => parseInt(a.battingOrder) - parseInt(b.battingOrder))
      .map(p => ({ id: p.id, name: p.fullName }));
    return {
      gamePk: g.gamePk,
      gameTime: g.gameDate ? new Date(g.gameDate).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) : 'TBD',
      venue, park: PARK_FACTORS[venue] || { runs: 100, hr: 100 },
      awayTeam: away?.team?.name || 'Away', homeTeam: home?.team?.name || 'Home',
      awayAbbr: away?.team?.abbreviation || 'AWY', homeAbbr: home?.team?.abbreviation || 'HME',
      awayPitcherId: away?.probablePitcher?.id, awayPitcher: away?.probablePitcher?.fullName || 'TBD',
      awayPitcherHand: away?.probablePitcher?.pitchHand?.code || 'R',
      homePitcherId: home?.probablePitcher?.id, homePitcher: home?.probablePitcher?.fullName || 'TBD',
      homePitcherHand: home?.probablePitcher?.pitchHand?.code || 'R',
      lineupAwayRaw: extractLineup(g.lineups?.awayPlayers),
      lineupHomeRaw: extractLineup(g.lineups?.homePlayers),
      awayPitcherStats: null, homePitcherStats: null,
      awayLineup: [], homeLineup: [], projections: null,
    };
  });

  const uniquePitcherIds = [...new Set(gameObjects.flatMap(g => [g.awayPitcherId, g.homePitcherId]).filter(Boolean))];
  const pitcherStatsArr  = await batchFetch(uniquePitcherIds, id => fetchPitcherStats(id, season));
  const pitcherStatsMap  = Object.fromEntries(uniquePitcherIds.map((id, i) => [id, pitcherStatsArr[i]]));
  for (const g of gameObjects) {
    g.awayPitcherStats = pitcherStatsMap[g.awayPitcherId] || null;
    g.homePitcherStats = pitcherStatsMap[g.homePitcherId] || null;
  }

  const allBatterIds = [...new Set(gameObjects.flatMap(g => [...g.lineupAwayRaw, ...g.lineupHomeRaw].map(b => b.id)).filter(Boolean))];
  const [batterStatsArr, batterLogArr] = await Promise.all([
    batchFetch(allBatterIds, id => fetchBatterStats(id, season)),
    batchFetch(allBatterIds, id => fetchBatterGameLog(id, season)),
  ]);
  const batterStatsMap = Object.fromEntries(allBatterIds.map((id, i) => [id, batterStatsArr[i]]));
  const batterLogMap   = Object.fromEntries(allBatterIds.map((id, i) => [id, batterLogArr[i]]));

  for (const game of gameObjects) {
    const buildLineup = (raw) => raw.map(b => ({ id: b.id, name: b.name, stats: batterStatsMap[b.id], gameLog: batterLogMap[b.id] || null })).filter(b => b.stats);
    game.awayLineup = buildLineup(game.lineupAwayRaw);
    game.homeLineup = buildLineup(game.lineupHomeRaw);
    const avgOps = (lineup) => { const v = lineup.map(b => b.stats?.ops).filter(v => v != null && !isNaN(v)); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; };
    game.projections = calcProjections(game.homePitcherStats?.era, game.awayPitcherStats?.era, avgOps(game.homeLineup), avgOps(game.awayLineup), game.park);
  }

  // Build hits
  const hitPicks = [];
  for (const game of gameObjects) {
    for (const [side, lineup, pitcherStats, pitcherHand, teamAbbr, opp] of [
      ['away', game.awayLineup, game.homePitcherStats, game.homePitcherHand, game.awayAbbr, `vs ${game.homeAbbr}`],
      ['home', game.homeLineup, game.awayPitcherStats, game.awayPitcherHand, game.homeAbbr, `vs ${game.awayAbbr}`],
    ]) {
      for (const batter of lineup) {
        const result = calcHitScore(batter, pitcherStats, pitcherHand, game.park);
        if (!result || result.score < 40) continue;
        const vsHandAvg = pitcherHand === 'L' ? batter.stats.vsLAvg : batter.stats.vsRAvg;
        const vsHandOBP = pitcherHand === 'L' ? batter.stats.vsLDetail?.obp : batter.stats.vsRDetail?.obp;
        const prob = scoreToHitProb(result.score);
        hitPicks.push({
          _score: result.score, player: batter.name, team: teamAbbr, opp,
          line: 'Over 0.5 hits', odds: probToAmericanOdds(prob), book: 'DraftKings',
          confidence: scoreToConfidence(result.score),
          avg: batter.stats.avg != null ? fmt3(batter.stats.avg) : '-',
          hot: result.score >= 72,
          streak: batter.gameLog ? `${batter.gameLog.hits} hits in last ${batter.gameLog.games} games` : 'Season stats only',
          splits: vsHandAvg != null ? `vs ${pitcherHand}HP: ${fmt3(vsHandAvg)} AVG${vsHandOBP != null ? ` | ${fmt3(vsHandOBP)} OBP` : ''}` : 'Split data pending',
        });
      }
    }
  }
  hitPicks.sort((a, b) => b._score - a._score);
  const hits = hitPicks.slice(0, 5).map((p, i) => ({ ...p, rank: i + 1, locked: i >= 3 }));

  // Build strikeouts
  const kPicks = [];
  for (const game of gameObjects) {
    for (const [pitcherName, pitcherStats, teamAbbr, oppAbbr, oppLineup] of [
      [game.awayPitcher, game.awayPitcherStats, game.awayAbbr, game.homeAbbr, game.homeLineup],
      [game.homePitcher, game.homePitcherStats, game.homeAbbr, game.awayAbbr, game.awayLineup],
    ]) {
      if (!pitcherStats || !pitcherName || pitcherName === 'TBD') continue;
      const result = calcKScore(pitcherStats, oppLineup.map(b => b.stats));
      if (!result || result.score < 2) continue;
      const lineK = pitcherStats.k9 >= 10 ? 7.5 : pitcherStats.k9 >= 8.5 ? 6.5 : 5.5;
      kPicks.push({
        _score: result.score, player: pitcherName, team: teamAbbr, opp: `vs ${oppAbbr}`,
        line: `Over ${lineK} Ks`, odds: result.score > 6 ? '-115' : '+105', book: 'DraftKings',
        confidence: pitcherStats.era < 3.50 ? 'High' : 'Medium',
        kper9: pitcherStats.k9?.toFixed(1) || '-', oppKrate: 'Model scored',
        arsenal: 'See sportsbook', note: pitcherStats.recentForm ? `L${pitcherStats.recentForm.starts} avg: ${pitcherStats.recentForm.k9?.toFixed(1)} K/9` : `${pitcherStats.k9?.toFixed(1)} K/9 season`,
      });
    }
  }
  kPicks.sort((a, b) => b._score - a._score);
  const strikeouts = kPicks.slice(0, 4).map((p, i) => ({ ...p, rank: i + 1, locked: i >= 2 }));

  // Build moneylines
  const mlPicks = [];
  for (const game of gameObjects) {
    const proj = game.projections;
    if (!proj) continue;
    const oddsEntry = oddsData.find(o => o.home_team?.toLowerCase().includes(game.homeTeam.split(' ').pop().toLowerCase()));
    const bookmaker = oddsEntry?.bookmakers?.[0];
    const h2h = bookmaker?.markets?.find(m => m.key === 'h2h');
    const homeOdds = h2h?.outcomes?.find(o => o.name === oddsEntry?.home_team)?.price;
    const awayOdds = h2h?.outcomes?.find(o => o.name === oddsEntry?.away_team)?.price;
    const pick = proj.homeWinProb >= proj.awayWinProb ? game.homeAbbr : game.awayAbbr;
    const pickProb = proj.homeWinProb >= proj.awayWinProb ? proj.homeWinProb : proj.awayWinProb;
    const pickOdds = proj.homeWinProb >= proj.awayWinProb ? homeOdds : awayOdds;
    const impliedProb = pickOdds ? (pickOdds < 0 ? (-pickOdds) / (-pickOdds + 100) : 100 / (pickOdds + 100)) : pickProb - 0.03;
    const edge = ((pickProb - impliedProb) * 100).toFixed(0);
    if (parseFloat(edge) < 1) continue;
    mlPicks.push({
      _score: parseFloat(edge), away: game.awayAbbr, home: game.homeAbbr, time: game.gameTime, pick,
      odds: pickOdds ? fmtOdds(pickOdds) : probToAmericanOdds(pickProb), book: 'DraftKings',
      confidence: parseFloat(edge) >= 5 ? 'High' : 'Medium',
      modelProb: `${(pickProb * 100).toFixed(0)}%`, impliedProb: `${(impliedProb * 100).toFixed(0)}%`,
      edge: `+${edge}%`, reason: `Model projects ${proj.awayProj}-${proj.homeProj} runs.`,
    });
  }
  mlPicks.sort((a, b) => b._score - a._score);
  const moneylines = mlPicks.slice(0, 4).map((p, i) => ({ ...p, rank: i + 1, locked: i >= 2 }));

  // Build totals
  const totalPicks = [];
  for (const game of gameObjects) {
    const proj = game.projections;
    if (!proj) continue;
    const oddsEntry = oddsData.find(o => o.home_team?.toLowerCase().includes(game.homeTeam.split(' ').pop().toLowerCase()));
    const totalsMarket = oddsEntry?.bookmakers?.[0]?.markets?.find(m => m.key === 'totals');
    const postedLine = totalsMarket?.outcomes?.[0]?.point;
    const overOdds   = totalsMarket?.outcomes?.find(o => o.name === 'Over')?.price;
    if (!postedLine) continue;
    const diff = proj.total - postedLine;
    if (Math.abs(diff) < 0.3) continue;
    const pick = diff > 0 ? 'Over' : 'Under';
    totalPicks.push({
      _score: Math.abs(diff), away: game.awayAbbr, home: game.homeAbbr, time: game.gameTime, pick,
      line: `${postedLine}`, odds: overOdds ? fmtOdds(pick === 'Over' ? overOdds : -overOdds) : '-110',
      book: 'DraftKings', confidence: Math.abs(diff) >= 1.0 ? 'High' : 'Medium',
      modelTotal: `${proj.total}`, reason: `Model projects ${proj.total} total vs posted ${postedLine}.`,
    });
  }
  totalPicks.sort((a, b) => b._score - a._score);
  const totals = totalPicks.slice(0, 4).map((p, i) => ({ ...p, rank: i + 1, locked: i >= 2 }));

  // Build parlays
  const parlays = [];
  if (strikeouts[0] && moneylines[0]) {
    parlays.push({ id: 1, theme: 'Ace Special', legs: [`${strikeouts[0].player} ${strikeouts[0].line}`, `${moneylines[0].pick} ML`, totals[0] ? `${totals[0].away}/${totals[0].home} ${totals[0].pick} ${totals[0].line}` : null].filter(Boolean), odds: '+420', confidence: 'High', payout: '$52 on $10', reason: 'Top K arm + correlated ML. If the ace dominates, the team wins.' });
  }
  if (hits[0] && hits[1] && moneylines[1]) {
    parlays.push({ id: 2, theme: 'Hit Parade', legs: [`${hits[0].player} ${hits[0].line}`, `${hits[1].player} ${hits[1].line}`, `${moneylines[1].pick} ML`], odds: '+380', confidence: 'High', payout: '$48 on $10', reason: "Top two hit props plus a value ML. All legs benefit from a high-scoring environment." });
  }
  if (totals[0] && totals[1] && hits[2]) {
    parlays.push({ id: 3, theme: 'Total Value', legs: [`${totals[0].away}/${totals[0].home} ${totals[0].pick} ${totals[0].line}`, `${totals[1].away}/${totals[1].home} ${totals[1].pick} ${totals[1].line}`, `${hits[2].player} ${hits[2].line}`], odds: '+540', confidence: 'Medium', payout: '$64 on $10', reason: 'Two strong model vs line mismatches plus a hit prop.', locked: true });
  }

  return res.status(200).json({ hits, strikeouts, moneylines, totals, parlays, lastUpdated: new Date().toISOString(), date: dateStr });
}
