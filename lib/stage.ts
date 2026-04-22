import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { StatefulTeamCompDiffStack } from "./stateful-stack";
import { StatelessTeamCompDiffStack } from "./stateless-stack";
import { ClientTeamCompDiffStack } from "./client-stack";

interface MyPipelineAppStageProps extends cdk.StackProps {
  region: string;
}

export class MyPipelineAppStage extends cdk.Stage {
  constructor(scope: Construct, stageName: string, props: MyPipelineAppStageProps) {
    super(scope, stageName, props);
    //dynamodb and cognito in stateful stack
    const StatefulStack = new StatefulTeamCompDiffStack(this, "StatefulTeamCompDiffStack", stageName, {
      region: props.region,
    });

    // only lambdas and sns and rest api
    const StatelessStack = new StatelessTeamCompDiffStack(this, "StatelessTeamCompDiffStack", stageName, {
      region: props.region,
      client: StatefulStack.client,
      userpool: StatefulStack.userpool,
    });

    // frontends stack
    const ClientStack = new ClientTeamCompDiffStack(this, "ClientTeamCompDiffStack", stageName, {
      apiUrl: StatelessStack.apiUrl,
      userpoolId: StatefulStack.userpoolId,
      userpoolClientId: StatefulStack.userpoolClientId,
    });
  }
}
