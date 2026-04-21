import * as cdk from "aws-cdk-lib";
import {
  ApiKeySourceType,
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  Cors,
  EndpointType,
  LambdaIntegration,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

interface StatelessTeamCompDiffStackProps extends cdk.StackProps {
  region: string;
  client: cdk.aws_cognito.UserPoolClient;
  userpool: cdk.aws_cognito.UserPool;
}

export class StatelessTeamCompDiffStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, stageName: string, props: StatelessTeamCompDiffStackProps) {
    super(scope, id, props);

    const authorizer = new CognitoUserPoolsAuthorizer(this, "TeamCompDiffCognitoAuthorizer", {
      cognitoUserPools: [props.userpool],
    });
    const ACCEPTED_SCOPES = ["email", "aws.cognito.signin.user.admin"];

    const api = new RestApi(this, "TeamCompDiffApi", {
      restApiName: "TeamCompDiffApi",
      defaultCorsPreflightOptions: {
        allowHeaders: ["Content-Type", "X-Amz-Date", "Authorization", "X-Api-Kay", "X-Session-Id"],
        allowMethods: ["OPTIONS", "GET", "POST", "PATCH", "DELETE", "PUT"],
        allowCredentials: true,
        allowOrigins: Cors.ALL_ORIGINS,
      },
      endpointTypes: [EndpointType.REGIONAL],
      apiKeySourceType: ApiKeySourceType.HEADER,
    });
    this.apiUrl = api.url;

    const testLambdaFn = new NodejsFunction(this, "testLambda", {
      entry: "lambda/testLambda.ts",
      handler: "handler",
      environment: {
        stageName: stageName,
        region: props.region,
      },
    });

    const getTestResource = api.root.addResource("test");
    const getTestData = new LambdaIntegration(testLambdaFn);
    getTestResource.addMethod("GET", getTestData, {
      authorizer: authorizer,
      authorizationType: AuthorizationType.COGNITO,
      authorizationScopes: ACCEPTED_SCOPES,
    });
  }
}
