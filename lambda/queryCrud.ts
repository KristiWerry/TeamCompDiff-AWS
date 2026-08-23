import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID } from "crypto";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const QUERIES_TABLE = process.env.QUERIES_TABLE!;
const TEAM_COMP_LAMBDA_NAME = process.env.TEAM_COMP_LAMBDA_NAME!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

function ok(body: object, statusCode = 200): APIGatewayProxyResult {
  return { statusCode, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function err(statusCode: number, message: string): APIGatewayProxyResult {
  return { statusCode, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ message }) };
}

function getUsername(event: APIGatewayProxyEvent): string {
  return event.requestContext.authorizer?.claims?.["cognito:username"] as string;
}

function parseBody(event: APIGatewayProxyEvent): Record<string, unknown> | null {
  try {
    return JSON.parse(event.body ?? "{}");
  } catch {
    return null;
  }
}

// ─── POST /queries ────────────────────────────────────────────────────────────

async function createQuery(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const username = getUsername(event);
  const body = parseBody(event);
  if (!body) return err(400, "Invalid JSON body");

  const { queryName, players } = body;

  if (typeof queryName !== "string" || !queryName.trim()) return err(400, "queryName is required");
  if (!Array.isArray(players) || players.length === 0 || players.length > 5) {
    return err(400, "players must be an array of 1–5 entries");
  }

  const item = {
    username,
    queryId: randomUUID(),
    queryName: queryName.trim(),
    players,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastResult: null,
  };

  await dynamo.send(new PutCommand({ TableName: QUERIES_TABLE, Item: item }));
  return ok(item, 201);
}

// ─── GET /queries ─────────────────────────────────────────────────────────────

async function listQueries(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const username = getUsername(event);

  const result = await dynamo.send(
    new QueryCommand({
      TableName: QUERIES_TABLE,
      KeyConditionExpression: "username = :u",
      ExpressionAttributeValues: { ":u": username },
      ScanIndexForward: false, // newest first
    })
  );

  return ok({ queries: result.Items ?? [] });
}

// ─── GET /queries/{queryId} ───────────────────────────────────────────────────

async function getQuery(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const username = getUsername(event);
  const queryId = event.pathParameters?.queryId;
  if (!queryId) return err(400, "queryId is required");

  const result = await dynamo.send(
    new GetCommand({ TableName: QUERIES_TABLE, Key: { username, queryId } })
  );

  if (!result.Item) return err(404, "Query not found");
  return ok(result.Item);
}

// ─── PUT /queries/{queryId} ───────────────────────────────────────────────────

async function updateQuery(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const username = getUsername(event);
  const queryId = event.pathParameters?.queryId;
  if (!queryId) return err(400, "queryId is required");

  const body = parseBody(event);
  if (!body) return err(400, "Invalid JSON body");

  const existing = await dynamo.send(
    new GetCommand({ TableName: QUERIES_TABLE, Key: { username, queryId } })
  );
  if (!existing.Item) return err(404, "Query not found");

  const { queryName, players } = body;
  const updated = {
    ...existing.Item,
    ...(typeof queryName === "string" && queryName.trim() && { queryName: queryName.trim() }),
    ...(Array.isArray(players) && players.length > 0 && { players }),
  };

  await dynamo.send(new PutCommand({ TableName: QUERIES_TABLE, Item: updated }));
  return ok(updated);
}

// ─── DELETE /queries/{queryId} ────────────────────────────────────────────────

async function deleteQuery(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const username = getUsername(event);
  const queryId = event.pathParameters?.queryId;
  if (!queryId) return err(400, "queryId is required");

  const existing = await dynamo.send(
    new GetCommand({ TableName: QUERIES_TABLE, Key: { username, queryId } })
  );
  if (!existing.Item) return err(404, "Query not found");

  await dynamo.send(new DeleteCommand({ TableName: QUERIES_TABLE, Key: { username, queryId } }));
  return ok({ deleted: true, queryId });
}

// ─── POST /queries/{queryId}/run ──────────────────────────────────────────────

async function runQuery(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const username = getUsername(event);
  const queryId = event.pathParameters?.queryId;
  if (!queryId) return err(400, "queryId is required");

  const existing = await dynamo.send(
    new GetCommand({ TableName: QUERIES_TABLE, Key: { username, queryId } })
  );
  if (!existing.Item) return err(404, "Query not found");

  const query = existing.Item;

  // Build a minimal API Gateway proxy event for the algorithm Lambda
  const algorithmPayload = {
    httpMethod: "POST",
    body: JSON.stringify({ players: query.players }),
    requestContext: { authorizer: { claims: { "cognito:username": username } } },
    pathParameters: null,
    queryStringParameters: null,
    headers: {},
  };

  const invokeRes = await lambda.send(
    new InvokeCommand({
      FunctionName: TEAM_COMP_LAMBDA_NAME,
      Payload: Buffer.from(JSON.stringify(algorithmPayload)),
    })
  );

  if (invokeRes.FunctionError) {
    return err(502, "Algorithm execution failed");
  }

  const lambdaResponse = JSON.parse(Buffer.from(invokeRes.Payload!).toString()) as {
    statusCode: number;
    body: string;
  };

  if (lambdaResponse.statusCode !== 200) {
    const parsed = JSON.parse(lambdaResponse.body) as { message?: string };
    return err(lambdaResponse.statusCode ?? 502, parsed.message ?? "Algorithm failed");
  }

  const result = JSON.parse(lambdaResponse.body) as object;
  const lastRunAt = new Date().toISOString();

  await dynamo.send(
    new PutCommand({
      TableName: QUERIES_TABLE,
      Item: { ...query, lastRunAt, lastResult: result },
    })
  );

  return ok({ ...result, lastRunAt });
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const queryId = event.pathParameters?.queryId;
  const isRun = event.resource?.endsWith("/run");

  if (!queryId) {
    if (method === "POST") return createQuery(event);
    if (method === "GET") return listQueries(event);
  } else if (isRun) {
    if (method === "POST") return runQuery(event);
  } else {
    if (method === "GET") return getQuery(event);
    if (method === "PUT") return updateQuery(event);
    if (method === "DELETE") return deleteQuery(event);
  }

  return err(405, "Method not allowed");
};
