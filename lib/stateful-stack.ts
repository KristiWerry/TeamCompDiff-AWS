import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  AccountRecovery,
  Mfa,
  OAuthScope,
  StringAttribute,
  UserPool,
  UserPoolClientIdentityProvider,
  UserPoolEmail,
  VerificationEmailStyle,
} from "aws-cdk-lib/aws-cognito";
import { AttributeType, TableClass, TableV2 } from "aws-cdk-lib/aws-dynamodb";

interface StatefulTeamCompDiffStackProps extends cdk.StackProps {
  region: string;
}

export class StatefulTeamCompDiffStack extends cdk.Stack {
  public readonly userpoolId: string;
  public readonly userpoolClientId: string;
  public readonly client: cdk.aws_cognito.UserPoolClient;
  public readonly userpool: cdk.aws_cognito.UserPool;
  public userDataTable: cdk.aws_dynamodb.TableV2;
  public queriesTable: cdk.aws_dynamodb.TableV2;
  public savedCompsTable: cdk.aws_dynamodb.TableV2;

  constructor(scope: Construct, id: string, stageName: string, props: StatefulTeamCompDiffStackProps) {
    super(scope, id, props);

    //create cognito pool with domain and client
    var userpoolParams: any = {
      userPoolName: "TeamCompDiff" + stageName,
      signInCaseSensitive: false, // case insensitive is preferred in most situations
      selfSignUpEnabled: false, // public can NOT create accounts
      userVerification: {
        emailSubject: `Verify your email for Team Comp Diff!`,
        emailBody: `Thanks for signing up to Team Comp Diff! Your verification code is {####}. \n
          Enter the verification code to set up your account within 10 minutes of receiving this email or you may encounter an error with logging in.
          `,
        emailStyle: VerificationEmailStyle.CODE,
        smsMessage: `Thanks for signing up to Team Comp Diff! Your verification code is {####}`,
      },
      signInAliases: {
        email: true,
      },
      autoVerify: { email: true },
      keepOriginal: {
        email: true,
      },
      mfa: Mfa.OFF,
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      deletionProtection: true,
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
    };
    this.userpool = new UserPool(this, "TeamCompDiff" + stageName, userpoolParams as cdk.aws_cognito.UserPoolProps);
    //uncomment when we have domain
    this.userpoolId = this.userpool.userPoolId;
    //userpool client
    this.client = this.userpool.addClient("TempCompDiff-client" + stageName, {
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PHONE],
        callbackUrls: [
          "http://localhost:3000/callback", // dev
          "https://yourdomain.com/callback", // prod TODO
        ],
        logoutUrls: [
          "http://localhost:3000",
          "https://yourdomain.com", //TODO
        ],
      },
      authFlows: {
        custom: true,
        userSrp: true,
      },
      authSessionValidity: cdk.Duration.minutes(15),
      accessTokenValidity: cdk.Duration.days(1),
      idTokenValidity: cdk.Duration.days(1),
      refreshTokenValidity: cdk.Duration.days(30),
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
    });
    this.userpoolClientId = this.client.userPoolClientId;
    const domain = this.userpool.addDomain("TCD-CognitoDomain", {
      cognitoDomain: {
        domainPrefix: `teamcompdiff-${stageName.toLowerCase()}`, // must be globally unique
      },
    });

    /**
     * DynamoDB tables
     */

    // Stores two item types per user:
    //   - Riot account link: PK=username, SK=riotId ("gameName#tagLine") → puuid, summonerId, champWinRates, champWinRatesCachedAt
    //   - User profile:      PK=username, SK="#profile"                  → champPool, preferredRole, displayName
    this.userDataTable = new TableV2(this, "TeamCompDiffUserDataTable", {
      partitionKey: { name: "username", type: AttributeType.STRING },
      sortKey: { name: "riotId", type: AttributeType.STRING },
      contributorInsights: true,
      tableClass: TableClass.STANDARD,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
    });

    // Allows the algorithm to look up cached win rate data for any Riot ID (friend lookups)
    this.userDataTable.addGlobalSecondaryIndex({
      indexName: "riotId-index",
      partitionKey: { name: "riotId", type: AttributeType.STRING },
    });

    // Saved algorithm inputs — users can re-run or modify these later
    this.queriesTable = new TableV2(this, "TeamCompQueriesTable", {
      partitionKey: { name: "username", type: AttributeType.STRING },
      sortKey: { name: "queryId", type: AttributeType.STRING },
      contributorInsights: true,
      tableClass: TableClass.STANDARD,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
    });

    // Specific generated team comps the user has chosen to save
    this.savedCompsTable = new TableV2(this, "TeamCompSavedCompsTable", {
      partitionKey: { name: "username", type: AttributeType.STRING },
      sortKey: { name: "compId", type: AttributeType.STRING },
      contributorInsights: true,
      tableClass: TableClass.STANDARD,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
    });
  }
}
