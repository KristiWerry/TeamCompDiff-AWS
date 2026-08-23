import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});

const TABLE_NAME = process.env.USER_DATA_TABLE!;
const RIOT_API_KEY_SECRET_ARN = process.env.RIOT_API_KEY_SECRET_ARN!;
const RIOT_REGIONAL_CLUSTER = process.env.RIOT_REGIONAL_CLUSTER ?? "americas";

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

let cachedApiKey: string | undefined;

async function getRiotApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: RIOT_API_KEY_SECRET_ARN }));
  cachedApiKey = result.SecretString!;
  return cachedApiKey;
}

async function riotGet(url: string, apiKey: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, { headers: { "X-Riot-Token": apiKey } });
  const data = res.ok ? await res.json() : null;
  return { ok: res.ok, status: res.status, data };
}

// Processes items in batches of `batchSize` concurrently, sequentially between batches.
// Keeps us well under the dev API key's 20 req/s limit.
async function fetchInBatches<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = await Promise.all(items.slice(i, i + batchSize).map(fn));
    results.push(...batch);
  }
  return results;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const username = event.requestContext.authorizer?.claims?.["cognito:username"] as string;

  const accountsResult = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "username = :u",
      ExpressionAttributeValues: { ":u": username },
    })
  );

  // Filter out the #profile item — only process Riot account link items
  const linkedAccounts = (accountsResult.Items ?? []).filter(item => item.riotId !== "#profile");

  if (linkedAccounts.length === 0) {
    return err(404, "No linked Riot accounts found. Link a Riot account first.");
  }

  let apiKey: string;
  try {
    apiKey = await getRiotApiKey();
  } catch {
    return err(500, "Failed to retrieve Riot API credentials");
  }

  const refreshed: Array<{ riotId: string; champsTracked: number }> = [];

  for (const account of linkedAccounts) {
    const { puuid, riotId } = account as { puuid: string; riotId: string };

    // Fetch last 50 match IDs across all queues (no queue filter = ranked + normal + flex)
    const matchIdsRes = await riotGet(
      `https://${RIOT_REGIONAL_CLUSTER}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?count=50`,
      apiKey
    );

    if (!matchIdsRes.ok) {
      refreshed.push({ riotId, champsTracked: 0 });
      continue;
    }

    const matchIds = matchIdsRes.data as string[];

    interface Participant { puuid: string; championName: string; win: boolean }
    interface MatchDetail { info: { participants: Participant[] } }

    // Fetch match details in batches of 5 to stay within Riot API rate limits
    const matchDetails = await fetchInBatches(matchIds, 5, (matchId) =>
      riotGet(
        `https://${RIOT_REGIONAL_CLUSTER}.api.riotgames.com/lol/match/v5/matches/${matchId}`,
        apiKey
      )
    );

    const champWinRates: Record<string, { wins: number; games: number }> = {};

    for (const matchRes of matchDetails) {
      if (!matchRes.ok || !matchRes.data) continue;
      const match = matchRes.data as MatchDetail;
      const participant = match.info.participants.find(p => p.puuid === puuid);
      if (!participant) continue;

      const { championName, win } = participant;
      if (!champWinRates[championName]) champWinRates[championName] = { wins: 0, games: 0 };
      champWinRates[championName].games++;
      if (win) champWinRates[championName].wins++;
    }

    const champWinRatesCachedAt = new Date().toISOString();
    await dynamo.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { ...account, champWinRates, champWinRatesCachedAt },
      })
    );

    refreshed.push({ riotId, champsTracked: Object.keys(champWinRates).length });
  }

  return ok({ refreshed });
};
