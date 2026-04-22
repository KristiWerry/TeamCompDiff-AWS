//testing lambda and rest api

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Credentials": true,
  "Access-Control-Allow-Origin": "*",
  "X-Requested-With": "*",
};

export const handler = async (event: any) => {
  console.log("Event", event);

  return {
    statusCode: 200,
    headers: headers,
    body: "Hello World. This is a test from lamdba",
  };
};
