import * as cdk from "aws-cdk-lib";
import { CodePipeline, CodePipelineSource, ShellStep } from "aws-cdk-lib/pipelines";
import { Construct } from "constructs";
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class TeamCompDiffAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //Create a pipeline for development so that devs can test different things
    new CodePipeline(this, "DevPipeline", {
      pipelineName: "DevPipeline",
      synth: new ShellStep("Synth", {
        input: CodePipelineSource.gitHub("KristiWerry/TeamCompDiff-AWS", "dev"),
        commands: ["npm ci", "npm run build", "npx cdk synth"],
      }),
      crossAccountKeys: true,
    });
  }
}
