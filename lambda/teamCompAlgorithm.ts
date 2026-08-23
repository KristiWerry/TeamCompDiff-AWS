import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import Anthropic from "@anthropic-ai/sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

type UserRole = "top" | "jungle" | "mid" | "adc" | "support";
type InputRole = UserRole | "fill";
type Archetype = "Teamfight" | "Poke" | "Pick" | "SplitPush" | "EarlyGame";
type PowerSpike = "early" | "mid" | "late";

const USER_ROLES: UserRole[] = ["top", "jungle", "mid", "adc", "support"];
const INPUT_ROLES: InputRole[] = [...USER_ROLES, "fill"];

// champions.json uses "bot" for ADC — map at lookup time
const CHAMP_ROLE: Record<UserRole, string> = {
  top: "top",
  jungle: "jungle",
  mid: "mid",
  adc: "bot",
  support: "support",
};

interface PlayerInput {
  primaryRole: InputRole;
  secondaryRole?: UserRole;
  champPool: string[];
  riotId?: string;
}

interface ChampionData {
  id: string;
  info: { attack: number; defense: number; magic: number; difficulty: number };
  roles?: string[];
  damagePattern?: string;
  range?: string;
  powerSpike?: PowerSpike;
  cc: Array<{ type: string; hard: boolean; duration: number; isUlt: boolean; multi: boolean }>;
  duelingCapability?: boolean;
  globalPresence?: string;
  mobility?: string;
  sustain?: string;
  teamfightRole?: string;
  functionTags?: string[];
  waveClear?: { early: string; late: string };
  synergies?: string[];
}

interface PlayerCache {
  winRates: Record<string, { wins: number; games: number }> | null;
  mastery: Record<string, { level: number; points: number }> | null;
}

interface ChampionSuggestion {
  champion: string;
  score: number;
  winRate: string | null;
  masteryLevel: number | null;
  impactNote: string;
}

interface PickSlot {
  role: UserRole;
  player: string | null;
  suggestions: ChampionSuggestion[];
}

interface SynergyPair {
  roles: [UserRole, UserRole];
  champions: [string, string];
  score: number;
}

interface TeamComp {
  archetype: string;
  description: string;
  roleAssignment: Partial<Record<UserRole, string>>;
  picks: PickSlot[];
  analysis: {
    difficulty: number;
    winConditions: string[];
    powerSpike: PowerSpike | "mixed";
    synergies: { overall: number; pairs: SynergyPair[] };
    suggestedPlaystyle: string;
    engage: string;
  };
  cacheAgesAt: Record<string, string>;
}

// ─── Champion data (bundled at deploy time) ───────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ALL_CHAMPIONS: Record<string, ChampionData> = (require("../data/champions.json") as { data: Record<string, ChampionData> }).data;

// ─── AWS clients ──────────────────────────────────────────────────────────────

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsClient = new SecretsManagerClient({});

const TABLE_NAME = process.env.USER_DATA_TABLE!;
const ANTHROPIC_SECRET_ARN = process.env.ANTHROPIC_API_KEY_SECRET_ARN!;

// Cache across warm invocations
let anthropicClient: Anthropic | undefined;

async function getAnthropic(): Promise<Anthropic> {
  if (anthropicClient) return anthropicClient;
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: ANTHROPIC_SECRET_ARN }));
  anthropicClient = new Anthropic({ apiKey: result.SecretString! });
  return anthropicClient;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function champCanPlayRole(champName: string, role: UserRole): boolean {
  const roles = ALL_CHAMPIONS[champName]?.roles;
  if (!roles) return false;
  const target = CHAMP_ROLE[role];
  return roles.some(r => r?.toLowerCase() === target);
}

function levelToNumber(level: string | undefined): number {
  if (level === "high") return 3;
  if (level === "medium") return 2;
  if (level === "low") return 1;
  return 0;
}

// ─── Win rate cache lookup (by riotId GSI) ────────────────────────────────────

async function fetchPlayerCache(riotId: string): Promise<PlayerCache> {
  try {
    const res = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "riotId-index",
        KeyConditionExpression: "riotId = :riotId",
        ExpressionAttributeValues: { ":riotId": riotId },
        Limit: 1,
      })
    );
    const item = res.Items?.[0];
    return {
      winRates: (item?.champWinRates as Record<string, { wins: number; games: number }>) ?? null,
      mastery: (item?.champMastery as Record<string, { level: number; points: number }>) ?? null,
    };
  } catch {
    return { winRates: null, mastery: null };
  }
}

// ─── Stage 1: Role assignment ─────────────────────────────────────────────────

function assignRoles(players: PlayerInput[]): Partial<Record<UserRole, PlayerInput>> {
  const candidates: { pi: number; role: UserRole; score: number }[] = [];

  for (let pi = 0; pi < players.length; pi++) {
    const p = players[pi];
    for (const role of USER_ROLES) {
      let score = 0;
      if (p.primaryRole === role) score += 3;
      else if (p.secondaryRole === role) score += 1;
      if (!p.champPool.some(c => champCanPlayRole(c, role))) score -= 10;
      candidates.push({ pi, role, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const usedPlayers = new Set<number>();
  const usedRoles = new Set<UserRole>();
  const result: Partial<Record<UserRole, PlayerInput>> = {};

  for (const { pi, role } of candidates) {
    if (usedPlayers.has(pi) || usedRoles.has(role)) continue;
    result[role] = players[pi];
    usedPlayers.add(pi);
    usedRoles.add(role);
    if (usedPlayers.size === players.length) break;
  }

  return result;
}

// ─── Stage 2: Champion scoring ────────────────────────────────────────────────

function archetypeFit(champ: ChampionData, arch: Archetype): number {
  const ft = champ.functionTags ?? [];
  const tfr = champ.teamfightRole ?? "";

  switch (arch) {
    case "Teamfight":
      return Math.min(
        (ft.includes("teamfight") || ft.includes("engage") ? 1.5 : 0) +
        (["initiator", "frontline", "hyper-carry"].includes(tfr) ? 1 : 0) +
        (champ.powerSpike === "late" ? 0.5 : 0) +
        (champ.cc.some(c => c.hard && c.multi) ? 0.5 : 0),
        3
      );
    case "Poke":
      return Math.min(
        (ft.includes("poke") ? 2 : 0) +
        (champ.range === "ranged" ? 0.5 : 0) +
        (champ.damagePattern === "burst" ? 0.3 : 0),
        3
      );
    case "Pick":
      return Math.min(
        (ft.includes("pick") || ft.includes("assassin") ? 2 : 0) +
        (["dash", "blink"].includes(champ.mobility ?? "") ? 0.5 : 0) +
        (["assassin", "pick-support"].includes(tfr) ? 0.5 : 0),
        3
      );
    case "SplitPush": {
      const mobility = champ.mobility ?? "none";
      const globalPresence = champ.globalPresence ?? "none";
      // Sidelane effectiveness: needs to push waves, win 1v1s, escape ganks, and optionally rejoin
      const mobilityScore = ["dash", "blink", "terrain-crossing"].includes(mobility) ? 0.5
        : ["speed-boost", "stealth"].includes(mobility) ? 0.25
        : 0;
      const globalScore = globalPresence === "high" ? 0.5
        : ["medium", "variable"].includes(globalPresence) ? 0.25
        : 0;
      return Math.min(
        (ft.includes("split-push") ? 1.5 : 0) +
        (champ.duelingCapability ? 0.5 : 0) +
        (levelToNumber(champ.waveClear?.late) >= 2 ? 0.5 : 0) +
        mobilityScore +
        globalScore,
        3
      );
    }
    case "EarlyGame":
      return Math.min(
        (champ.powerSpike === "early" ? 2 : 0) +
        (ft.includes("snowball") || ft.includes("skirmisher") ? 0.5 : 0) +
        (champ.duelingCapability ? 0.5 : 0),
        3
      );
  }
}

function impactNote(
  champName: string,
  arch: Archetype,
  rank: number, // 0 = top pick
  picks: Partial<Record<UserRole, string>>
): string {
  const c = ALL_CHAMPIONS[champName];
  if (!c) return "Alternative option";
  const ft = c.functionTags ?? [];

  if (rank === 0) {
    if (arch === "Teamfight" && (ft.includes("engage") || c.cc.some(x => x.hard && x.multi))) return "Core engage piece — anchors teamfight identity";
    if (arch === "Poke" && ft.includes("poke")) return "Primary poke source — enables siege playstyle";
    if (arch === "SplitPush" && ft.includes("split-push")) return "Split push threat — creates constant map pressure";
    if (arch === "EarlyGame" && c.powerSpike === "early") return "Early power spike — sets the pace of the game";
    if (arch === "Pick" && (ft.includes("pick") || ft.includes("assassin"))) return "Pick threat — creates fog-of-war pressure";
    return "Best fit for this comp's identity";
  }

  if (ft.includes("split-push") && arch !== "SplitPush") return "Introduces split push — shifts away from grouped play";
  if (ft.includes("engage") && arch === "Poke") return "Adds engage — comp shifts toward hybrid poke-fight";
  if (ft.includes("poke") && arch === "Teamfight") return "Less engage — comp leans toward poke-first";
  if (c.powerSpike === "late") return "Later power spike — requires more patient scaling";
  if (c.powerSpike === "early") return "Earlier power spike — more aggressive, weaker late game";
  return "Alternative pick — adjusts comp style slightly";
}

function selectChampions(
  role: UserRole,
  player: PlayerInput | null,
  arch: Archetype,
  picks: Partial<Record<UserRole, string>>,
  cache: PlayerCache | null
): { slot: PickSlot; topPick: string | null } {
  const pool = player
    ? (player.champPool.filter(c => champCanPlayRole(c, role)).length > 0
        ? player.champPool.filter(c => champCanPlayRole(c, role))
        : player.champPool)
    : Object.keys(ALL_CHAMPIONS).filter(c => champCanPlayRole(c, role));

  const scored = pool.map(champName => {
    const champ = ALL_CHAMPIONS[champName];
    let score = 0;
    let winRateStr: string | null = null;
    let masteryLevel: number | null = null;

    // Win rate (up to 3 pts) — ignored if fewer than 5 games
    const wr = cache?.winRates?.[champName];
    if (wr && wr.games >= 5) {
      score += (wr.wins / wr.games) * 3;
      winRateStr = `${Math.round((wr.wins / wr.games) * 100)}% (${wr.games} games)`;
    }

    // Mastery (up to 2 pts) — level 7 = full 2pts; comfort matters especially in lower elo
    const m = cache?.mastery?.[champName];
    if (m && m.level > 0) {
      masteryLevel = m.level;
      score += (m.level / 7) * 2;
    }

    // Synergy with already-picked champions (up to 2 pts)
    for (const picked of Object.values(picks)) {
      if (!picked || !champ) continue;
      if (champ.synergies?.includes(picked)) score += 0.5;
      if (ALL_CHAMPIONS[picked]?.synergies?.includes(champName)) score += 0.5;
    }

    // Archetype fit (up to 3 pts)
    if (champ) score += archetypeFit(champ, arch);

    return { champName, score: Math.round(score * 10) / 10, winRateStr, masteryLevel };
  });

  scored.sort((a, b) => b.score - a.score);
  const top3 = scored.slice(0, 3);
  const topPick = top3[0]?.champName ?? null;

  return {
    slot: {
      role,
      player: player ? player.riotId ?? "Player" : null,
      suggestions: top3.map((s, i) => ({
        champion: s.champName,
        score: s.score,
        winRate: s.winRateStr,
        masteryLevel: s.masteryLevel,
        impactNote: impactNote(s.champName, arch, i, picks),
      })),
    },
    topPick,
  };
}

// ─── Synergy model (all 10 role pairs, weighted) ──────────────────────────────

const PAIR_WEIGHTS: Record<string, number> = {
  "adc-support": 1.5,
  "jungle-mid": 1.3,
  "jungle-support": 1.2,
};

function scoreSynergies(picks: Partial<Record<UserRole, string>>): { overall: number; pairs: SynergyPair[] } {
  const filled = USER_ROLES.filter(r => picks[r]) as UserRole[];
  const pairs: SynergyPair[] = [];
  let weightedSum = 0;
  let totalWeight = 0;

  for (let i = 0; i < filled.length; i++) {
    for (let j = i + 1; j < filled.length; j++) {
      const rA = filled[i], rB = filled[j];
      const cA = picks[rA]!, cB = picks[rB]!;
      let raw = 0;
      if (ALL_CHAMPIONS[cA]?.synergies?.includes(cB)) raw += 1;
      if (ALL_CHAMPIONS[cB]?.synergies?.includes(cA)) raw += 1;
      const score = raw * 5;

      const key = [rA, rB].sort().join("-");
      const weight = PAIR_WEIGHTS[key] ?? 1.0;
      weightedSum += score * weight;
      totalWeight += weight;
      pairs.push({ roles: [rA, rB], champions: [cA, cB], score });
    }
  }

  const overall = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : 0;
  return { overall, pairs: pairs.sort((a, b) => b.score - a.score) };
}

// ─── Analysis helpers ─────────────────────────────────────────────────────────

function computeDifficulty(picks: Partial<Record<UserRole, string>>): number {
  const vals = Object.values(picks).filter(Boolean).map(c => ALL_CHAMPIONS[c!]?.info.difficulty ?? 5);
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 5;
}

function computePowerSpike(picks: Partial<Record<UserRole, string>>): PowerSpike | "mixed" {
  const counts = { early: 0, mid: 0, late: 0 };
  for (const c of Object.values(picks)) {
    const s = ALL_CHAMPIONS[c!]?.powerSpike;
    if (s && s in counts) counts[s]++;
  }
  const max = Math.max(counts.early, counts.mid, counts.late);
  if (counts.early === max && counts.early > 0 && counts.mid < max && counts.late < max) return "early";
  if (counts.late === max && counts.late > 0 && counts.early < max && counts.mid < max) return "late";
  if (counts.mid === max && counts.mid > 0 && counts.early < max && counts.late < max) return "mid";
  return "mixed";
}

function computeEngage(picks: Partial<Record<UserRole, string>>): string {
  const hardCC = Object.values(picks)
    .filter(Boolean)
    .reduce((sum, c) => sum + (ALL_CHAMPIONS[c!]?.cc.filter(x => x.hard).length ?? 0), 0);
  if (hardCC >= 4) return "Very High";
  if (hardCC >= 2) return "High";
  if (hardCC === 1) return "Medium";
  return "Low";
}

function computePlaystyle(arch: Archetype): string {
  const styles: Record<Archetype, string> = {
    Teamfight: "Group for objectives and force teamfights when ahead",
    Poke: "Apply poke pressure from range, siege objectives, force fights at a health deficit",
    Pick: "Look for pick opportunities in the fog of war, convert gold leads into objectives",
    SplitPush: "Apply split-push pressure, force the enemy to respond 1v1 or concede objectives",
    EarlyGame: "Establish early leads through aggressive skirmishing and convert into objectives before the enemy scales",
  };
  return styles[arch];
}

// ─── LLM: description + win conditions (all comps in parallel) ───────────────

async function generateNarrative(
  arch: string,
  picks: Partial<Record<UserRole, string>>,
  analysis: { difficulty: number; powerSpike: PowerSpike | "mixed"; synergies: { overall: number }; engage: string }
): Promise<{ description: string; winConditions: string[] }> {
  const picksStr = Object.entries(picks).map(([r, c]) => `${r}: ${c}`).join(", ");

  const prompt = `You are a League of Legends coach. Given the following team comp data, write a brief analysis.

Archetype: ${arch}
Picks: ${picksStr}
Difficulty: ${analysis.difficulty}/10
Power spike: ${analysis.powerSpike}
Engage level: ${analysis.engage}
Team synergy: ${analysis.synergies.overall}/10

Respond with valid JSON only (no markdown, no code blocks):
{
  "description": "2-3 sentence identity summary of this team comp and how it wins",
  "winConditions": ["specific win condition 1", "specific win condition 2", "specific win condition 3"]
}`;

  try {
    const client = await getAnthropic();
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const parsed = JSON.parse(text);
    return {
      description: typeof parsed.description === "string" ? parsed.description : "",
      winConditions: Array.isArray(parsed.winConditions) ? parsed.winConditions : [],
    };
  } catch {
    return {
      description: `A ${arch.toLowerCase()} team composition.`,
      winConditions: ["Execute your primary strategy", "Control vision around objectives", "Translate your advantage to a win"],
    };
  }
}

// ─── Stage 3: Archetype viability + comp generation ───────────────────────────

const ARCHETYPE_LABELS: Record<Archetype, string> = {
  Teamfight: "Teamfight",
  Poke: "Poke / Siege",
  Pick: "Pick Comp",
  SplitPush: "Split Push",
  EarlyGame: "Early Game",
};

const VIABILITY_THRESHOLD = 0.4;
const ALL_ARCHETYPES: Archetype[] = ["Teamfight", "Poke", "Pick", "SplitPush", "EarlyGame"];

function archetypeViability(roleAssignment: Partial<Record<UserRole, PlayerInput>>, arch: Archetype): number {
  const scores: number[] = [];
  for (const [role, player] of Object.entries(roleAssignment) as [UserRole, PlayerInput][]) {
    if (!player) continue;
    const eligible = player.champPool.filter(c => champCanPlayRole(c, role));
    const pool = eligible.length > 0 ? eligible : player.champPool;
    const best = Math.max(...pool.map(c => ALL_CHAMPIONS[c] ? archetypeFit(ALL_CHAMPIONS[c], arch) : 0));
    scores.push(best);
  }
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
}

async function buildComp(
  arch: Archetype,
  roleAssignment: Partial<Record<UserRole, PlayerInput>>,
  playerNumbers: Map<PlayerInput, number>,
  playerCacheMap: Map<string, PlayerCache>
): Promise<TeamComp> {
  const picks: Partial<Record<UserRole, string>> = {};
  const slots: PickSlot[] = [];

  for (const role of USER_ROLES) {
    const player = roleAssignment[role] ?? null;
    const cache = player?.riotId ? (playerCacheMap.get(player.riotId) ?? null) : null;
    const { slot, topPick } = selectChampions(role, player, arch, picks, cache);

    // Label slot by player number
    if (slot.player && player) slot.player = `Player ${playerNumbers.get(player) ?? "?"}`;

    slots.push(slot);
    if (topPick) picks[role] = topPick;
  }

  const synergies = scoreSynergies(picks);
  const difficulty = computeDifficulty(picks);
  const powerSpike = computePowerSpike(picks);
  const engage = computeEngage(picks);
  const suggestedPlaystyle = computePlaystyle(arch);

  const { description, winConditions } = await generateNarrative(
    ARCHETYPE_LABELS[arch], picks, { difficulty, powerSpike, synergies, engage }
  );

  const roleAssignmentOut: Partial<Record<UserRole, string>> = {};
  for (const role of USER_ROLES) {
    const player = roleAssignment[role];
    roleAssignmentOut[role] = player ? `Player ${playerNumbers.get(player) ?? "?"}` : "Suggested Fill";
  }

  const cacheAgesAt: Record<string, string> = {};
  for (const player of Object.values(roleAssignment)) {
    if (player?.riotId && playerCacheMap.has(player.riotId)) {
      cacheAgesAt[player.riotId] = new Date().toISOString();
    }
  }

  return {
    archetype: ARCHETYPE_LABELS[arch],
    description,
    roleAssignment: roleAssignmentOut,
    picks: slots,
    analysis: { difficulty, winConditions, powerSpike, synergies, suggestedPlaystyle, engage },
    cacheAgesAt,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Content-Type": "application/json",
};

const ok = (body: object): APIGatewayProxyResult => ({ statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) });
const err = (code: number, message: string): APIGatewayProxyResult => ({ statusCode: code, headers: CORS_HEADERS, body: JSON.stringify({ message }) });

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let body: { players?: unknown };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return err(400, "Invalid JSON body");
  }

  if (!Array.isArray(body.players) || body.players.length === 0 || body.players.length > 5) {
    return err(400, "players must be an array of 1–5 entries");
  }

  const rawPlayers = body.players as PlayerInput[];
  const requestingUsername: string = event.requestContext.authorizer?.claims?.["cognito:username"] ?? "";

  // Validate and apply profile fallback (champPool optional if player is the requesting user with no provided pool)
  const players: PlayerInput[] = [];
  for (const p of rawPlayers) {
    if (!p.primaryRole || !INPUT_ROLES.includes(p.primaryRole)) {
      return err(400, `primaryRole must be one of: ${INPUT_ROLES.join(", ")}`);
    }
    if (p.primaryRole === "fill" && p.secondaryRole) {
      return err(400, "secondaryRole cannot be set when primaryRole is fill");
    }
    if (p.secondaryRole && !USER_ROLES.includes(p.secondaryRole)) {
      return err(400, `secondaryRole must be one of: ${USER_ROLES.join(", ")}`);
    }
    if (p.secondaryRole && p.secondaryRole === p.primaryRole) {
      return err(400, "primaryRole and secondaryRole must be different");
    }

    let champPool = p.champPool ?? [];

    // If no champPool provided, try to load from the requesting user's profile
    if (champPool.length === 0 && requestingUsername) {
      const profile = await dynamo.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { username: requestingUsername, riotId: "#profile" } })
      );
      champPool = (profile.Item?.champPool as string[]) ?? [];
    }

    if (!Array.isArray(champPool) || champPool.length === 0) {
      return err(400, "Each player must have a champPool (or be the requesting user with a saved profile pool)");
    }

    players.push({ ...p, champPool });
  }

  // Fetch cached win rates + mastery for all players with a riotId
  const playerCacheMap = new Map<string, PlayerCache>();
  await Promise.all(
    players
      .filter(p => p.riotId)
      .map(async p => {
        const cache = await fetchPlayerCache(p.riotId!);
        playerCacheMap.set(p.riotId!, cache);
      })
  );

  // Track player numbers for labeling
  const playerNumbers = new Map<PlayerInput, number>();
  players.forEach((p, i) => playerNumbers.set(p, i + 1));

  // Stage 1: Assign roles
  const roleAssignment = assignRoles(players);

  // Score archetype viability, always include top 5 sorted by fit, ensure minimum 3
  const ranked = ALL_ARCHETYPES
    .map(arch => ({ arch, viability: archetypeViability(roleAssignment, arch) }))
    .sort((a, b) => b.viability - a.viability);

  const viable = ranked.filter(a => a.viability >= VIABILITY_THRESHOLD);
  const selected = viable.length >= 3 ? viable : ranked.slice(0, 3);
  const finalArchetypes = selected.slice(0, 5).map(a => a.arch);

  // Stage 3: Generate all comps in parallel (LLM calls run concurrently)
  const comps = await Promise.all(
    finalArchetypes.map(arch => buildComp(arch, roleAssignment, playerNumbers, playerCacheMap))
  );

  return ok({ comps });
};
