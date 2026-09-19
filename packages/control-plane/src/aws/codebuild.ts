import { CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand } from '@aws-sdk/client-codebuild';

export async function buildAgentImage(agentId: string, repoUrl: string): Promise<string> {
  const client = new CodeBuildClient({ region: process.env.AWS_REGION || 'us-east-1' });

  const startRes = await client.send(
    new StartBuildCommand({
      projectName: 'factory-agent-builder',
      sourceLocationOverride: repoUrl,
      environmentVariablesOverride: [
        {
          name: 'AGENT_ID',
          value: agentId,
          type: 'PLAINTEXT'
        }
      ]
    })
  );

  const buildId = startRes.build?.id;
  if (!buildId) {
    throw new Error('Failed to start CodeBuild: build ID not returned');
  }

  while (true) {
    await new Promise(resolve => setTimeout(resolve, 5000));

    const batchRes = await client.send(
      new BatchGetBuildsCommand({
        ids: [buildId]
      })
    );

    const build = batchRes.builds?.[0];
    if (!build) {
      throw new Error(`Build ${buildId} not found in CodeBuild`);
    }

    if (build.buildStatus === 'SUCCEEDED') {
      const ecrRepoUri = process.env.FACTORY_ECR_REPO_URI;
      if (!ecrRepoUri) {
        throw new Error('FACTORY_ECR_REPO_URI environment variable is not set');
      }
      return `${ecrRepoUri}:${agentId}`;
    }

    if (build.buildStatus === 'FAILED' || build.buildStatus === 'FAULT' || build.buildStatus === 'TIMED_OUT' || build.buildStatus === 'STOPPED') {
      throw new Error(`CodeBuild failed with status: ${build.buildStatus}`);
    }
    
    // Status is likely IN_PROGRESS, continuing the loop...
  }
}
