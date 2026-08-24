import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.USER_DATA_TABLE!;
const PROFILE_SK = "#profile";
const VALID_ROLES = ["top", "jungle", "mid", "adc", "support"] as const;
type Role = (typeof VALID_ROLES)[number];

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

function getUsername(event: APIGatewayProxyEvent): string {
  return event.requestContext.authorizer?.claims?.["cognito:username"] as string;
}

function isValidRole(role: unknown): role is Role {
  return VALID_ROLES.includes(role as Role);
}

async function getProfile(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const username = getUsername(event);

  const result = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { username, riotId: PROFILE_SK } })
  );

  const item = result.Item;
  return ok({
    champPool: item?.champPool ?? [],
    preferredRole: item?.preferredRole ?? null,
    preferredSecondaryRole: item?.preferredSecondaryRole ?? null,
    displayName: item?.displayName ?? null,
    theme: item?.theme ?? null,
  });
}

async function updateProfile(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const username = getUsername(event);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return err(400, "Invalid JSON body");
  }

  const { champPool, preferredRole, preferredSecondaryRole, displayName, theme } = body;

  if (champPool !== undefined) {
    if (!Array.isArray(champPool) || champPool.some((c: unknown) => typeof c !== "string")) {
      return err(400, "champPool must be an array of strings");
    }
  }

  if (preferredRole !== undefined && !isValidRole(preferredRole)) {
    return err(400, `preferredRole must be one of: ${VALID_ROLES.join(", ")}`);
  }

  if (preferredSecondaryRole !== undefined && preferredSecondaryRole !== null && !isValidRole(preferredSecondaryRole)) {
    return err(400, `preferredSecondaryRole must be one of: ${VALID_ROLES.join(", ")}`);
  }

  if (
    preferredRole !== undefined &&
    preferredSecondaryRole !== undefined &&
    preferredSecondaryRole !== null &&
    preferredRole === preferredSecondaryRole
  ) {
    return err(400, "preferredRole and preferredSecondaryRole must be different");
  }

  // Fetch existing item so PUT acts as a partial update (only overwrites provided fields)
  const existing = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { username, riotId: PROFILE_SK } })
  );

  const current = existing.Item ?? {};
  const updated: Record<string, unknown> = {
    ...current,
    username,
    riotId: PROFILE_SK,
    ...(champPool !== undefined && { champPool }),
    ...(preferredRole !== undefined && { preferredRole }),
    ...(preferredSecondaryRole !== undefined && { preferredSecondaryRole }),
    ...(displayName !== undefined && { displayName }),
    ...(theme !== undefined && { theme }),
  };

  await dynamo.send(new PutCommand({ TableName: TABLE_NAME, Item: updated }));

  return ok({
    champPool: updated.champPool ?? [],
    preferredRole: updated.preferredRole ?? null,
    preferredSecondaryRole: updated.preferredSecondaryRole ?? null,
    displayName: updated.displayName ?? null,
    theme: updated.theme ?? null,
  });
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (event.httpMethod === "GET") return getProfile(event);
  if (event.httpMethod === "PUT") return updateProfile(event);
  return err(405, "Method not allowed");
};
