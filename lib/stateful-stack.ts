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

interface StatefulTeampCompDiffStackProps extends cdk.StackProps {
  region: string;
}

export class StatefulTeampCompDiffStack extends cdk.Stack {
  public readonly userpoolId: string;
  public readonly userpoolClientId: string;
  public readonly client: cdk.aws_cognito.UserPoolClient;
  public readonly userpool: cdk.aws_cognito.UserPool;

  constructor(scope: Construct, id: string, stageName: string, props: StatefulTeampCompDiffStackProps) {
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
    this.userpoolId = this.userpoolId;
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
  }
}
