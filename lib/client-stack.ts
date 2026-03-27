// Define domain, certificate, and DNS settings in a single CDK stack file
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

interface ClientTeamCompDiffStackProps extends cdk.StackProps {
  apiUrl: string;
  loginUrl: string;
}

export class ClientTeamCompDiffStack extends cdk.Stack {
  constructor(scope: Construct, id: string, stageName: string, props: ClientTeamCompDiffStackProps) {
    super(scope, id, props);
    //TODO connect frontend git repo to be hosted on amplify
  }
}
