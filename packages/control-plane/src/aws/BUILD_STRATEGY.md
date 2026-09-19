# Agent Container Build Strategy

## Objective
To establish a secure, cloud-native architecture for building agent Docker images dynamically when `POST /api/v1/registry/agents` is invoked with a GitHub repository URL, transitioning the Factory to a native PaaS model.

## Evaluated Approaches

### 1. AWS CodeBuild (Recommended)
AWS CodeBuild is a fully managed build service that compiles source code, runs tests, and produces ready-to-deploy software packages (including Docker images).

**Architecture Flow:**
1. **API Invocation:** `POST /api/v1/registry/agents` receives a GitHub URL.
2. **Trigger Build:** The Factory's Control Plane (via AWS SDK) calls `StartBuild` on a pre-provisioned generic AWS CodeBuild project, passing the GitHub URL and target ECR repository/tag as environment variables (or source overrides).
3. **Build Execution:** CodeBuild pulls the source code, executes the `docker build`, and pushes the resulting image to Amazon ECR.
4. **Completion:** CodeBuild emits events to EventBridge on success/failure, which the Control Plane consumes to update the agent's deployment status.

**Pros:**
- **Security:** Fully isolated, ephemeral build environments. No privileged containers required in the Control Plane.
- **Scalability:** Automatically scales to handle multiple concurrent agent builds.
- **Native Integration:** Seamless integration with IAM, ECR, and EventBridge.
- **Serverless:** No underlying compute to manage for builds (unlike EC2-based ECS).

### 2. Docker-in-Docker (DinD) on ECS
Running the Docker daemon inside an ECS container (where the Factory runs) to build images locally.

**Cons (Why it is NOT recommended):**
- **Security Risk:** Requires containers to run in `privileged` mode, exposing the host instance to severe security risks (container escape).
- **Fargate Incompatibility:** AWS Fargate does not support `privileged` containers. You would be forced to use ECS on EC2, increasing operational overhead.
- **Resource Contention:** Builds can be highly CPU/memory intensive, potentially starving the Control Plane API processes if run on the same compute nodes.

## ECR Authentication & IAM Configuration

Using AWS CodeBuild simplifies authentication. You do not need to manually manage long-lived ECR credentials or `docker login` commands. Authentication is handled natively via AWS IAM.

1. **CodeBuild Service Role:** Create an IAM role for the CodeBuild project with the following ECR permissions to push images:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "ecr:GetAuthorizationToken",
           "ecr:BatchCheckLayerAvailability",
           "ecr:GetDownloadUrlForLayer",
           "ecr:GetRepositoryPolicy",
           "ecr:DescribeRepositories",
           "ecr:ListImages",
           "ecr:DescribeImages",
           "ecr:BatchGetImage",
           "ecr:InitiateLayerUpload",
           "ecr:UploadLayerPart",
           "ecr:CompleteLayerUpload",
           "ecr:PutImage"
         ],
         "Resource": "*"
       }
     ]
   }
   ```
   *(Note: Resource can be restricted to specific ECR repository ARNs for tighter security).*

2. **Control Plane Role:** The Factory Control Plane needs `codebuild:StartBuild` permission to initiate the builds, and `events:PutRule` / `sqs:ReceiveMessage` depending on how EventBridge responses are processed.

## Recommendation Summary
For a secure, scalable, and cloud-native PaaS architecture on AWS, **AWS CodeBuild** is the definitive choice for on-the-fly container builds. It avoids the severe security implications and infrastructure limitations of DinD, maintains compatibility with serverless compute (Fargate), and integrates securely and natively with Amazon ECR via IAM roles.
