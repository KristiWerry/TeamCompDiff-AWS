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
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

interface StatelessTeamCompDiffStackProps extends cdk.StackProps {
  region: string;
  client: cdk.aws_cognito.UserPoolClient;
  userpool: cdk.aws_cognito.UserPool;
  userDataTable: cdk.aws_dynamodb.TableV2;
  queriesTable: cdk.aws_dynamodb.TableV2;
  savedCompsTable: cdk.aws_dynamodb.TableV2;
}

export class StatelessTeamCompDiffStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, stageName: string, props: StatelessTeamCompDiffStackProps) {
    super(scope, id, props);

    const authorizer = new CognitoUserPoolsAuthorizer(this, "TeamCompDiffCognitoAuthorizer", {
      cognitoUserPools: [props.userpool],
    });
    const cognitoAuth = {
      authorizer: authorizer,
      authorizationType: AuthorizationType.COGNITO,
    };

    const api = new RestApi(this, "TeamCompDiffApi" + stageName, {
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
    getTestResource.addMethod("GET", getTestData, cognitoAuth);

    // Public endpoint — champions.json is static game data needed by the frontend before login
    const championDataFn = new NodejsFunction(this, "championData", {
      entry: "lambda/championData.ts",
      handler: "handler",
      environment: {
        stageName: stageName,
        region: props.region,
      },
    });

    const championsResource = api.root.addResource("champions");
    championsResource.addMethod("GET", new LambdaIntegration(championDataFn));

    const profileCrudFn = new NodejsFunction(this, "profileCrud", {
      entry: "lambda/profileCrud.ts",
      handler: "handler",
      environment: {
        stageName: stageName,
        region: props.region,
        USER_DATA_TABLE: props.userDataTable.tableName,
      },
    });
    props.userDataTable.grantReadWriteData(profileCrudFn);

    const profileResource = api.root.addResource("profile");
    profileResource.addMethod("GET", new LambdaIntegration(profileCrudFn), cognitoAuth);
    profileResource.addMethod("PUT", new LambdaIntegration(profileCrudFn), cognitoAuth);

    // Riot API key stored in Secrets Manager — create this secret manually in AWS console
    // before deploying. Secret name: TeamCompDiff/{stageName}/RiotApiKey
    const riotApiKeySecret = Secret.fromSecretNameV2(
      this,
      "RiotApiKeySecret",
      `TeamCompDiff/${stageName}/RiotApiKey`
    );

    const linkRiotAccountFn = new NodejsFunction(this, "linkRiotAccount", {
      entry: "lambda/linkRiotAccount.ts",
      handler: "handler",
      environment: {
        stageName: stageName,
        region: props.region,
        USER_DATA_TABLE: props.userDataTable.tableName,
        RIOT_API_KEY_SECRET_ARN: riotApiKeySecret.secretArn,
        RIOT_REGIONAL_CLUSTER: "americas",
        RIOT_PLATFORM: "na1",
      },
    });
    props.userDataTable.grantReadWriteData(linkRiotAccountFn);
    riotApiKeySecret.grantRead(linkRiotAccountFn);

    const refreshPlayerCacheFn = new NodejsFunction(this, "refreshPlayerCache", {
      entry: "lambda/refreshPlayerCache.ts",
      handler: "handler",
      timeout: cdk.Duration.seconds(60),
      environment: {
        stageName: stageName,
        region: props.region,
        USER_DATA_TABLE: props.userDataTable.tableName,
        RIOT_API_KEY_SECRET_ARN: riotApiKeySecret.secretArn,
        RIOT_REGIONAL_CLUSTER: "americas",
      },
    });
    props.userDataTable.grantReadWriteData(refreshPlayerCacheFn);
    riotApiKeySecret.grantRead(refreshPlayerCacheFn);

    const playersResource = api.root.addResource("players");
    const linkRiotResource = playersResource.addResource("link-riot");
    const refreshCacheResource = playersResource.addResource("refresh-cache");
    linkRiotResource.addMethod("POST", new LambdaIntegration(linkRiotAccountFn), cognitoAuth);
    refreshCacheResource.addMethod("POST", new LambdaIntegration(refreshPlayerCacheFn), cognitoAuth);

    const anthropicKeySecret = Secret.fromSecretNameV2(
      this,
      "AnthropicApiKeySecret",
      `TeamCompDiff/${stageName}/AnthropicApiKey`
    );

    const teamCompAlgorithmFn = new NodejsFunction(this, "teamCompAlgorithm", {
      entry: "lambda/teamCompAlgorithm.ts",
      handler: "handler",
      environment: {
        stageName: stageName,
        region: props.region,
        USER_DATA_TABLE: props.userDataTable.tableName,
        ANTHROPIC_API_KEY_SECRET_ARN: anthropicKeySecret.secretArn,
      },
    });
    props.userDataTable.grantReadData(teamCompAlgorithmFn);
    anthropicKeySecret.grantRead(teamCompAlgorithmFn);

    const teamCompResource = api.root.addResource("team-comp");
    teamCompResource.addMethod("POST", new LambdaIntegration(teamCompAlgorithmFn), cognitoAuth);

    const queryCrudFn = new NodejsFunction(this, "queryCrud", {
      entry: "lambda/queryCrud.ts",
      handler: "handler",
      environment: {
        stageName: stageName,
        region: props.region,
        QUERIES_TABLE: props.queriesTable.tableName,
        TEAM_COMP_LAMBDA_NAME: teamCompAlgorithmFn.functionName,
      },
    });
    props.queriesTable.grantReadWriteData(queryCrudFn);
    teamCompAlgorithmFn.grantInvoke(queryCrudFn);

    const queriesResource = api.root.addResource("queries");
    const queryIdResource = queriesResource.addResource("{queryId}");
    const runResource = queryIdResource.addResource("run");

    queriesResource.addMethod("POST", new LambdaIntegration(queryCrudFn), cognitoAuth);
    queriesResource.addMethod("GET", new LambdaIntegration(queryCrudFn), cognitoAuth);
    queryIdResource.addMethod("GET", new LambdaIntegration(queryCrudFn), cognitoAuth);
    queryIdResource.addMethod("PUT", new LambdaIntegration(queryCrudFn), cognitoAuth);
    queryIdResource.addMethod("DELETE", new LambdaIntegration(queryCrudFn), cognitoAuth);
    runResource.addMethod("POST", new LambdaIntegration(queryCrudFn), cognitoAuth);

    const savedCompsCrudFn = new NodejsFunction(this, "savedCompsCrud", {
      entry: "lambda/savedCompsCrud.ts",
      handler: "handler",
      environment: {
        stageName: stageName,
        region: props.region,
        SAVED_COMPS_TABLE: props.savedCompsTable.tableName,
      },
    });
    props.savedCompsTable.grantReadWriteData(savedCompsCrudFn);

    const compsResource = api.root.addResource("comps");
    const compIdResource = compsResource.addResource("{compId}");

    compsResource.addMethod("POST", new LambdaIntegration(savedCompsCrudFn), cognitoAuth);
    compsResource.addMethod("GET", new LambdaIntegration(savedCompsCrudFn), cognitoAuth);
    compIdResource.addMethod("GET", new LambdaIntegration(savedCompsCrudFn), cognitoAuth);
    compIdResource.addMethod("DELETE", new LambdaIntegration(savedCompsCrudFn), cognitoAuth);
  }
}
