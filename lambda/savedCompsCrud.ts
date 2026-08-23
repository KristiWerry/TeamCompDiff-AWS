import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SAVED_COMPS_TABLE = process.env.SAVED_COMPS_TABLE!;

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

// ─── POST /comps ──────────────────────────────────────────────────────────────

async function saveComp(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const username = getUsername(event);
  const body = parseBody(event);
  if (!body) return err(400, "Invalid JSON body");

  const { compName, comp, queryId } = body;

  if (typeof compName !== "string" || !compName.trim()) return err(400, "compName is required");
  if (typeof comp !== "object" || comp === null || Array.isArray(comp)) return err(400, "comp is required and must be an object");

  const item: Record<string, unknown> = {
    username,
    compId: randomUUID(),
    compName: compName.trim(),
    comp,
    savedAt: new Date().toISOString(),
  };

  if (typeof queryId === "string" && queryId.trim()) {
    item.queryId = queryId.trim();
  }

  await dynamo.send(new PutCommand({ TableName: SAVED_COMPS_TABLE, Item: item }));
  return ok(item, 201);
}

// ─── GET /comps ───────────────────────────────────────────────────────────────

async function listComps(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const username = getUsername(event);

  const result = await dynamo.send(
    new QueryCommand({
      TableName: SAVED_COMPS_TABLE,
      KeyConditionExpression: "username = :u",
      ExpressionAttributeValues: { ":u": username },
      ScanIndexForward: false,
    })
  );

  return ok({ comps: result.Items ?? [] });
}

// ─── GET /comps/{compId} ──────────────────────────────────────────────────────

async function getComp(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const username = getUsername(event);
  const compId = event.pathParameters?.compId;
  if (!compId) return err(400, "compId is required");

  const result = await dynamo.send(
    new GetCommand({ TableName: SAVED_COMPS_TABLE, Key: { username, compId } })
  );

  if (!result.Item) return err(404, "Comp not found");
  return ok(result.Item);
}

// ─── DELETE /comps/{compId} ───────────────────────────────────────────────────

async function deleteComp(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const username = getUsername(event);
  const compId = event.pathParameters?.compId;
  if (!compId) return err(400, "compId is required");

  const existing = await dynamo.send(
    new GetCommand({ TableName: SAVED_COMPS_TABLE, Key: { username, compId } })
  );
  if (!existing.Item) return err(404, "Comp not found");

  await dynamo.send(new DeleteCommand({ TableName: SAVED_COMPS_TABLE, Key: { username, compId } }));
  return ok({ deleted: true, compId });
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const compId = event.pathParameters?.compId;

  if (!compId) {
    if (method === "POST") return saveComp(event);
    if (method === "GET") return listComps(event);
  } else {
    if (method === "GET") return getComp(event);
    if (method === "DELETE") return deleteComp(event);
  }

  return err(405, "Method not allowed");
};
