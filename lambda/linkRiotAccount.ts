import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// Build championId (numeric string) → championName map from bundled champions.json
// eslint-disable-next-line @typescript-eslint/no-require-imports
const CHAMP_ID_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(
    (require("../data/champions.json") as { data: Record<string, { key: string }> }).data
  ).map(([name, data]) => [data.key, name])
);

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});

const TABLE_NAME = process.env.USER_DATA_TABLE!;
const RIOT_API_KEY_SECRET_ARN = process.env.RIOT_API_KEY_SECRET_ARN!;
const RIOT_REGIONAL_CLUSTER = process.env.RIOT_REGIONAL_CLUSTER ?? "americas";
const RIOT_PLATFORM = process.env.RIOT_PLATFORM ?? "na1";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

function ok(body: object): APIGatewayProxyResult {
  return { statusCode: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function err(statusCode: number, message: string): APIGatewayProxyResult {
  return { statusCode, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ message }) };
}

// Cache API key across warm Lambda invocations to avoid repeated Secrets Manager calls
let cachedApiKey: string | undefined;

async function getRiotApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: RIOT_API_KEY_SECRET_ARN }));
  cachedApiKey = result.SecretString!;
  return cachedApiKey;
}

async function riotGet(path: string, apiKey: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(path, { headers: { "X-Riot-Token": apiKey } });
  const data = res.ok ? await res.json() : null;
  return { ok: res.ok, status: res.status, data };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const username = event.requestContext.authorizer?.claims?.["cognito:username"] as string;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return err(400, "Invalid JSON body");
  }

  const riotId = body.riotId;
  if (typeof riotId !== "string" || !riotId.includes("#")) {
    return err(400, 'riotId is required and must be in "gameName#tagLine" format');
  }

  const hashIndex = riotId.indexOf("#");
  const gameName = riotId.substring(0, hashIndex);
  const tagLine = riotId.substring(hashIndex + 1);

  if (!gameName || !tagLine) {
    return err(400, 'riotId must have a non-empty gameName and tagLine (e.g. "Faker#KR1")');
  }

  // Check if this Riot ID is already linked to this user
  const existing = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { username, riotId } })
  );
  if (existing.Item) {
    return err(409, "This Riot ID is already linked to your account");
  }

  let apiKey: string;
  try {
    apiKey = await getRiotApiKey();
  } catch {
    return err(500, "Failed to retrieve Riot API credentials");
  }

  // Resolve Riot ID → PUUID via account-v1 (regional cluster endpoint)
  const accountRes = await riotGet(
    `https://${RIOT_REGIONAL_CLUSTER}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    apiKey
  );

  if (accountRes.status === 404) return err(404, "Riot ID not found. Check the gameName and tagLine.");
  if (accountRes.status === 429) return err(429, "Riot API rate limit reached. Please try again shortly.");
  if (!accountRes.ok) return err(502, "Failed to verify Riot ID with Riot API");

  const { puuid } = accountRes.data as { puuid: string; gameName: string; tagLine: string };

  // Resolve PUUID → summonerID via summoner-v4 (platform endpoint)
  const summonerRes = await riotGet(
    `https://${RIOT_PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`,
    apiKey
  );

  if (!summonerRes.ok) return err(502, "Failed to retrieve summoner data from Riot API");

  const { id: summonerId } = summonerRes.data as { id: string };

  // Fetch top 50 champion masteries — higher mastery = more comfortable on that champ
  interface MasteryEntry { championId: number; championLevel: number; championPoints: number }
  const masteryRes = await riotGet(
    `https://${RIOT_PLATFORM}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}?count=50`,
    apiKey
  );

  const champMastery: Record<string, { level: number; points: number }> = {};
  if (masteryRes.ok && Array.isArray(masteryRes.data)) {
    for (const entry of masteryRes.data as MasteryEntry[]) {
      const champName = CHAMP_ID_TO_NAME[String(entry.championId)];
      if (champName) {
        champMastery[champName] = { level: entry.championLevel, points: entry.championPoints };
      }
    }
  }

  const linkedAt = new Date().toISOString();
  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { username, riotId, puuid, summonerId, champMastery, linkedAt },
    })
  );

  return ok({ riotId, puuid, summonerId, linkedAt });
};
