# TeamCompDiff — AWS Backend

League of Legends team composition optimizer. Players input their roles and champion pools; the algorithm outputs 3-5 distinct team comp strategies with champion suggestions and full analysis. Built on AWS CDK (TypeScript). Frontend (NextJS) lives in a separate repo: `KristiWerry/TeamCompDiff-Client`.

## Project Structure

```
bin/                        CDK app entry points
lib/
  stateful-stack.ts         Cognito UserPool + DynamoDB tables
  stateless-stack.ts        API Gateway + Lambda functions
  client-stack.ts           Amplify frontend hosting
  stage.ts                  Orchestrates all three stacks
  team_comp_diff-aws-stack.ts       Production pipeline (main branch → us-west-1)
  team_comp_diff-dev-aws-stack.ts   Dev pipeline (dev branch → us-east-2)
lambda/                     Lambda function handlers
  testLambda.ts             Placeholder test endpoint
data/
  champions.json            Champion database (~160 champs) — core algorithm engine + served to frontend
```

## Infrastructure Overview

- **Stateful stack**: Cognito UserPool (email sign-in, admin-only account creation) + DynamoDB tables
- **Stateless stack**: API Gateway (regional, CORS all origins) + Lambda (NodejsFunction, bundled TypeScript)
- **Client stack**: Amplify hosting, auto-deploys from GitHub, passes API URL + Cognito IDs to frontend as env vars
- **Pipelines**: CodePipeline triggers on GitHub push — `dev` branch → us-east-2, `main` branch → us-west-1

## Auth

All endpoints are Cognito-protected **except `GET /champions`**, which is public. Champion data is static, non-sensitive game data needed by the frontend before login (champion picker UI). All other routes use `CognitoUserPoolsAuthorizer`. Username is always extracted from Cognito token claims in the Lambda (`event.requestContext.authorizer.claims['cognito:username']`) — never trusted from the request body. Scopes: `["email", "aws.cognito.signin.user.admin"]`.

## DynamoDB Tables

### 1. TeamCompDiffUserDataTable (existing — needs extension)

Two item patterns in the same table:

**Riot account link item:**
```
PK: username (Cognito username)
SK: riotId ("gameName#tagLine" format)
Fields: puuid, summonerId, champMastery, linkedAt, champWinRates, champWinRatesCachedAt
```
- `puuid` — permanent, fetched once on account link via Riot account-v1 API
- `summonerId` — permanent, fetched once via Riot summoner-v4 API
- `champMastery` — `Map<champName, { level: number, points: number }>` — top 50 champion masteries, fetched once on account link. Higher mastery = more comfortable on that champ
- `linkedAt` — ISO timestamp of when the account was linked
- `champWinRates` — `Map<champName, { wins: number, games: number }>` — aggregated across ranked + normal + flex. Derived from match history via `refreshPlayerCache`, NOT directly from Riot API
- `champWinRatesCachedAt` — ISO timestamp, refreshed on-demand. Stored for display ("data last updated X") but not used as DynamoDB TTL

**User profile item:**
```
PK: username (Cognito username)
SK: "#profile"
Fields: champPool (string[]), preferredRole, displayName
```

**GSI needed:** `riotId` as PK (no SK) — allows algorithm to look up any Riot ID (for friend lookups) without knowing the owning username.

### 2. TeamCompQueriesTable (new)

Saved algorithm inputs. Users can re-run or modify these.

```
PK: username
SK: queryId (UUID)
Fields: queryName, players (full input array), createdAt, lastRunAt, lastResult?
```

### 3. TeamCompSavedCompsTable (new)

Specific generated team comps the user wants to keep.

```
PK: username
SK: compId (UUID)
Fields: compName, queryId? (optional reference to originating query), comp (full output object), savedAt
```

## API Endpoints

| Method | Path | Lambda | Auth | Notes |
|--------|------|--------|------|-------|
| GET | /champions | championData | **Public** | Serves champions.json — single source of truth for frontend + backend |
| GET | /profile | profileCrud | Cognito | Get user's profile (champ pool, preferred role) |
| PUT | /profile | profileCrud | Cognito | Save/update champ pool and profile data |
| POST | /players/link-riot | linkRiotAccount | Cognito | Validate Riot ID, store PUUID + summonerID, trigger cache refresh |
| POST | /players/refresh-cache | refreshPlayerCache | Cognito | Rebuild win rate cache from match history |
| POST | /team-comp | teamCompAlgorithm | Cognito | Run algorithm → returns 3-5 comps |
| POST | /queries | queryCrud | Cognito | Save algorithm inputs as a named query |
| GET | /queries | queryCrud | Cognito | List user's saved queries |
| GET | /queries/{queryId} | queryCrud | Cognito | Get a saved query |
| PUT | /queries/{queryId} | queryCrud | Cognito | Update a saved query |
| DELETE | /queries/{queryId} | queryCrud | Cognito | Delete a saved query |
| POST | /queries/{queryId}/run | queryCrud | Cognito | Re-run a saved query with latest cached data |
| POST | /comps | savedCompsCrud | Cognito | Save a specific generated team comp |
| GET | /comps | savedCompsCrud | Cognito | List user's saved team comps |
| GET | /comps/{compId} | savedCompsCrud | Cognito | Get a saved comp |
| DELETE | /comps/{compId} | savedCompsCrud | Cognito | Delete a saved comp |

## Lambda Functions

| Name | Entry file | Purpose |
|------|-----------|---------|
| championData | lambda/championData.ts | Reads and returns champions.json |
| linkRiotAccount | lambda/linkRiotAccount.ts | Riot ID → PUUID + summonerID + champMastery, stored permanently |
| refreshPlayerCache | lambda/refreshPlayerCache.ts | Fetch last ~50 matches across all queues, build champWinRates map |
| teamCompAlgorithm | lambda/teamCompAlgorithm.ts | Core algorithm — bundles champions.json, reads DynamoDB cache, calls LLM |
| queryCrud | lambda/queryCrud.ts | All /queries routes including /run |
| profileCrud | lambda/profileCrud.ts | GET + PUT /profile |
| savedCompsCrud | lambda/savedCompsCrud.ts | All /comps routes |

## champions.json — Single Source of Truth

Located at `data/champions.json`. Served to the frontend via `GET /champions`. Also bundled inside `teamCompAlgorithm` Lambda at deploy time (not fetched from S3 or network at runtime). Updated per patch (~every 2 weeks) — update once here, both backend and frontend get the new version on next deploy.

Key fields used by the algorithm:
- `roles` — which roles a champion can play. **Note: ADC is stored as `"bot"` in the JSON**, mapped internally to `"adc"` via a `CHAMP_ROLE` constant in the algorithm
- `tags` — champion class (Fighter, Mage, Assassin, etc.)
- `powerSpike` — early / mid / late
- `functionTags` — e.g. "split-push", "teamfight", "poke", "assassin", "engage"
- `teamfightRole` — initiator, carry, peeler, etc.
- `synergies` — list of champion names that synergize well
- `cc` — array of CC abilities with type, duration, hard/soft flags
- `mobility` — none / dash / blink / terrain-crossing / speed-boost / stealth
- `globalPresence` — none / low / medium / high / variable
- `waveClear` — object with `early`, `mid`, `late` rated none(0) / low(1) / medium(2) / high(3)
- `duelingCapability` — boolean, whether the champion can reliably win 1v1 sidelane duels
- `sustain`, `damagePattern`

## Riot API Usage — Minimal by Design

Riot API is called ONLY during account link and cache refresh — never at algorithm runtime.

**Lookup flow (once on account link):**
```
POST body: { riotId: "gameName#tagLine" }
→ account-v1:  GET /riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}            → PUUID (permanent)
→ summoner-v4: GET /lol/summoner/v4/summoners/by-puuid/{puuid}                          → summonerID (permanent)
→ mastery-v4:  GET /lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}?count=50 → champMastery map
```

**Cache refresh (~51 calls, weekly or on-demand):**
```
→ match-v5/ids: GET last 50 match IDs across all queues (ranked 420, flex 440, normal 400) — no queue filter
→ match-v5/{matchId}: fetch each match detail → extract championName + win per match
→ aggregate into champWinRates map (total wins + games across all queues) → write to DynamoDB
```

Win rates are derived from match history. The Riot API does not expose win rates directly.

## Team Comp Algorithm

**Input (POST /team-comp):**
```json
{
  "players": [
    {
      "primaryRole": "mid",
      "secondaryRole": "jungle",
      "champPool": ["Zed", "Akali", "Syndra"],
      "riotId": "gameName#tagLine"
    }
  ]
}
```

- No `queueType` — all match history data (ranked + normal + flex combined) is used for win rate scoring
- `players` array: 1–5 entries (partial team supported — empty roles get suggested fills)
- `champPool` per player: if omitted and `riotId` matches the requesting user, fall back to their `#profile` champPool from DynamoDB
- `riotId`: optional — if provided, look up cached win rates by GSI on riotId (can be self or a friend's Riot ID)
- To lock a specific champion pick, re-call the endpoint with that player's `champPool` set to a single champion. The algorithm treats a single-item pool as a locked pick and computes full analysis around it.

**Stage 1 — Role Assignment**

Score every player × role combination:
- +3 primary role preference
- +1 secondary role preference
- +0 otherwise
- Heavy penalty if player has zero champions in their pool that can play this role (per champions.json `roles` field)

Run greedy optimal assignment to give each player a unique role. Empty slots (partial team) filled after players.

**Stage 2 — Champion Selection**

For each player in their assigned role, filter champ pool to role-eligible champions, then score each candidate (10 points total):

| Signal | Max pts | Notes |
|--------|---------|-------|
| Win rate | 3 | From `champWinRates` cache — skipped if fewer than 5 games played |
| Champion mastery | 2 | `(masteryLevel / 7) * 2` — from `champMastery` cache stored on account link |
| Synergy | 2 | Score vs. already-selected picks (see Synergy Model) |
| Archetype fit | 3 | How well the champion serves the target archetype (see below) |

**Split push archetype fit** uses additional signals beyond `functionTags`:
- `mobility`: dash/blink/terrain-crossing → +0.5, speed-boost/stealth → +0.25
- `globalPresence`: high → +0.5, medium/variable → +0.25 (can apply pressure elsewhere while splitting)
- `waveClear.late`: medium or higher → +0.5
- `duelingCapability`: true → +0.5

Return top 3 suggestions per role. Each suggestion includes an `impactNote` explaining how the comp shifts if that champion is chosen (e.g. "removes hard engage, comp becomes poke-oriented"), and `masteryLevel` (1–7 or null if no mastery data).

For empty slots: suggest 3 champions from the full champion pool that best fit the archetype and synergize with filled picks.

**Stage 3 — Generate 3-5 Team Comps by Archetype**

Generates comps targeting different strategic identities based on what the champ pools can support. Archetypes that the pools can't meaningfully fill are dropped. Minimum 3 returned.

| Archetype | What it maximizes |
|-----------|------------------|
| Teamfight | AoE CC, teamfightRole initiator/carry, late power spikes |
| Poke/Siege | Ranged damage, functionTags poke, mid power spikes |
| Pick comp | functionTags assassin/pick, high mobility, catch potential |
| Split push | functionTags split-push + mobility + globalPresence + waveClear + duelingCapability |
| Early game | powerSpike early, skirmish + early objective control |

## Synergy Model

All **10 possible role pairs** (C(5,2)) are scored individually then combined into an overall team synergy score.

**Pair weights (higher = more impactful synergy):**
| Pair | Weight |
|------|--------|
| ADC + Support | 1.5x |
| Mid + Jungle | 1.3x |
| Support + Jungle | 1.2x |
| All other pairs | 1.0x |

**Scoring a pair:** Check if champA is in champB's `synergies` list (+1) AND if champB is in champA's `synergies` list (+1). Normalize 0–10. Team overall synergy = weighted sum of all 10 pairs.

Output includes pair-level scores so users understand where synergy comes from:
```json
"synergies": {
  "overall": 7.4,
  "pairs": [
    { "roles": ["adc", "support"], "champions": ["Jinx", "Thresh"], "score": 9 },
    { "roles": ["mid", "jungle"], "champions": ["Orianna", "Amumu"], "score": 8 },
    { "roles": ["support", "jungle"], "champions": ["Thresh", "Amumu"], "score": 7 }
  ]
}
```

## LLM Integration (Claude Haiku via Bedrock or Anthropic API)

Used for two fields per comp that benefit from natural language — everything else stays algorithmic:

1. **`description`** — 2-3 sentence identity summary of the team comp
2. **`winConditions`** — 2-3 bullet points on how to win with this comp

The Lambda passes structured comp data (archetype, picks, synergy scores, CC profile, power spikes, functionTags) as context and prompts for natural language output. Claude Haiku is chosen for cost (~fractions of a cent per call). Use Amazon Bedrock to keep everything within AWS (IAM auth, no separate API key). If Bedrock is unavailable, fall back to Anthropic API directly.

Win condition and description generation are the same LLM call to minimize latency and cost.

## Full Output Shape Per Comp

```json
{
  "archetype": "Teamfight",
  "description": "A late-scaling engage comp built around a devastating Amumu + Orianna combo...",
  "roleAssignment": { "top": "Player 1", "jungle": "Player 2", "mid": "Player 3", "adc": "Player 4", "support": "Player 5" },
  "picks": [
    {
      "role": "top",
      "player": "Player 1",
      "suggestions": [
        { "champion": "Malphite", "score": 8.4, "winRate": "58% (23 games)", "masteryLevel": 6, "impactNote": "Adds hard engage, anchors teamfight identity" },
        { "champion": "Garen", "score": 6.1, "winRate": null, "masteryLevel": null, "impactNote": "Lower difficulty, removes engage — comp leans poke" },
        { "champion": "Fiora", "score": 5.8, "winRate": "44% (9 games)", "masteryLevel": 4, "impactNote": "Enables split push but weakens teamfight significantly" }
      ]
    }
  ],
  "analysis": {
    "difficulty": 7,
    "winConditions": ["Chain Amumu ult into Orianna shockwave for game-ending teamfight", "Scale to 3 items before forcing Baron"],
    "powerSpike": "late",
    "synergies": {
      "overall": 7.4,
      "pairs": [...]
    },
    "suggestedPlaystyle": "Scale to late game, group for teamfights around objectives",
    "engage": "High"
  },
  "cacheAgesAt": {
    "gameName#tagLine": "2026-08-01T10:00:00Z"
  }
}
```

`winRate` is always present per suggestion but may be `null` if no cache exists or fewer than 5 games played. `masteryLevel` (1–7) comes from the `champMastery` field stored in DynamoDB at account link time — `null` if the player has no linked Riot account or hasn't played that champion. Algorithm works fully without either — both enrich scoring when available.

## Build Order (all complete)

1. DynamoDB schema — GSI on userDataTable + two new tables in `stateful-stack.ts`
2. `championData` Lambda + public `GET /champions` endpoint
3. `profileCrud` Lambda + `/profile` endpoints
4. `linkRiotAccount` Lambda + endpoint (includes mastery fetch)
5. `teamCompAlgorithm` Lambda — core algorithm (champions.json bundled, mastery + win rate scoring, LLM call for description/win conditions)
6. `queryCrud` Lambda + `/queries` endpoints
7. `savedCompsCrud` Lambda + `/comps` endpoints
8. `refreshPlayerCache` Lambda + `POST /players/refresh-cache` endpoint

## Conventions

- Lambda handlers: `export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult>`
- Username always extracted from `event.requestContext.authorizer.claims['cognito:username']` — never from request body
- CORS headers returned on all Lambda responses (configured at API Gateway level but include in Lambda too)
- Environment variables passed to every Lambda: `stageName`, `region`, relevant table names
- champions.json is bundled at Lambda deploy time — never fetched from S3 or network at runtime
- LLM calls are only made from `teamCompAlgorithm` — no other Lambda uses the LLM
