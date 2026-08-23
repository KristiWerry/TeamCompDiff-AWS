import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const championsData = require("../data/champions.json");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

export const handler = async (_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(championsData),
  };
};
