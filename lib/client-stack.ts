// Define domain, certificate, and DNS settings in a single CDK stack file
import { App, GitHubSourceCodeProvider, RedirectStatus } from "@aws-cdk/aws-amplify-alpha";
import * as cdk from "aws-cdk-lib";
import { PublicHostedZone } from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

interface ClientTeamCompDiffStackProps extends cdk.StackProps {
  apiUrl: string;
  userpoolId: string;
  userpoolClientId: string;
}

export class ClientTeamCompDiffStack extends cdk.Stack {
  constructor(scope: Construct, id: string, stageName: string, props: ClientTeamCompDiffStackProps) {
    super(scope, id, props);

    if (stageName === "main") {
      const amplifyApp = new App(this, `TeamCompDiff`, {
        environmentVariables: {
          PUBLIC_API_BASE_URL: props.apiUrl ?? "",
          PUBLIC_COGNITO_USER_POOL_ID: props.userpoolId ?? "",
          PUBLIC_COGNITO_USER_POOL_CLIENT_ID: props.userpoolClientId ?? "",
        },
        sourceCodeProvider: new GitHubSourceCodeProvider({
          owner: "KristiWerry",
          repository: "TeamCompDiff-Client",
          oauthToken: cdk.SecretValue.secretsManager("github-token"),
        }),
        autoBranchDeletion: true, // Automatically disconnect a branch when you delete a branch from your repository
      });
      amplifyApp.addCustomRule({
        source: "/<*>",
        target: "/index.html",
        status: RedirectStatus.NOT_FOUND,
      });
      amplifyApp.addCustomRule({
        source: String.raw`</^[^.]+$|\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|ttf|map|json|otf)$)([^.]+$)/>`,
        target: "/index.html",
        status: RedirectStatus.REWRITE,
      });
      amplifyApp.addBranch("main"); //TODO change to dev when we have prod
    }
  }
}
