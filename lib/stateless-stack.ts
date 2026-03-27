import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

interface StatelessTeamCompDiffStackProps extends cdk.StackProps {
  region: string;
  loginUrl: string;
  client: cdk.aws_cognito.UserPoolClient;
  userpool: cdk.aws_cognito.UserPool;
}

export class StatelessTeamCompDiffStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, stageName: string, props: StatelessTeamCompDiffStackProps) {
    super(scope, id, props);
  }
}
