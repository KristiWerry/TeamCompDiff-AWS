import * as cdk from "aws-cdk-lib";
import { CodePipeline, CodePipelineSource, ShellStep } from "aws-cdk-lib/pipelines";
import { Construct } from "constructs";
import { MyPipelineAppStage } from "./stage";

export class TeamCompDiffAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //Create a pipeline for development so that devs can test different things
    const devPipeline = new CodePipeline(this, "DevPipeline", {
      pipelineName: "DevPipeline",
      synth: new ShellStep("Synth", {
        input: CodePipelineSource.gitHub("KristiWerry/TeamCompDiff-AWS", "dev"),
        commands: ["npm ci", "npm run build", "npx cdk synth"],
      }),
      crossAccountKeys: true,
    });

    //dev staging site for researchers to test new features
    const testingStage = devPipeline.addStage(
      new MyPipelineAppStage(this, "dev", {
        region: "us-east-2",
      })
    );

    //Create a pipeline for production
    new CodePipeline(this, "TeamCompDiffMainPipeline", {
      pipelineName: "TeamCompDiffMainPipeline",
      synth: new ShellStep("Synth", {
        input: CodePipelineSource.gitHub("KristiWerry/TeamCompDiff-AWS", "main"),
        commands: ["npm ci", "npm run build", "npx cdk synth"],
      }),
      crossAccountKeys: true,
    });
  }
}
