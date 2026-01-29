import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as path from 'path';

export class McpAtlassianStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const MCP_PORT = 9000;

    // ----------------------------------------------------------------
    // Context: optionally import an existing VPC (e.g. langbuilder-vpc)
    // Set "existingVpcName" in cdk.json or via -c existingVpcName=langbuilder-vpc
    // ----------------------------------------------------------------
    const existingVpcName: string | null = this.node.tryGetContext('existingVpcName');

    // CIDR allowed to reach the MCP server (default: VPC-internal only)
    const allowedCidr: string = this.node.tryGetContext('allowedCidr') ?? '10.0.0.0/16';

    // ----------------------------------------------------------------
    // VPC — reuse existing or create a minimal new one
    // ----------------------------------------------------------------
    let vpc: ec2.IVpc;

    if (existingVpcName) {
      vpc = ec2.Vpc.fromLookup(this, 'ImportedVpc', {
        vpcName: existingVpcName,
      });
    } else {
      vpc = new ec2.Vpc(this, 'McpVpc', {
        vpcName: 'mcp-atlassian-vpc',
        ipAddresses: ec2.IpAddresses.cidr('10.1.0.0/16'),
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration: [
          {
            cidrMask: 24,
            name: 'mcp-public',
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            cidrMask: 24,
            name: 'mcp-private',
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
        ],
      });
    }

    // ----------------------------------------------------------------
    // Secrets Manager — Atlassian credentials
    // ----------------------------------------------------------------
    const atlassianSecret = new secretsmanager.Secret(this, 'AtlassianCredentials', {
      secretName: 'mcp-atlassian/credentials',
      description: 'Atlassian API credentials for mcp-atlassian server',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          JIRA_URL: 'https://your-domain.atlassian.net',
          JIRA_USERNAME: 'user@company.com',
          JIRA_API_TOKEN: 'CHANGE_ME',
          CONFLUENCE_URL: 'https://your-domain.atlassian.net/wiki',
          CONFLUENCE_USERNAME: 'user@company.com',
          CONFLUENCE_API_TOKEN: 'CHANGE_ME',
        }),
        generateStringKey: '_rotation_placeholder',
      },
    });

    // ----------------------------------------------------------------
    // ECR Repository
    // ----------------------------------------------------------------
    const ecrRepo = new ecr.Repository(this, 'McpAtlassianRepo', {
      repositoryName: 'mcp-atlassian',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          tagStatus: ecr.TagStatus.ANY,
          description: 'Keep last 10 images',
          maxImageCount: 10,
        },
      ],
    });

    // Build and push the Docker image from the repo root
    const dockerImage = new DockerImageAsset(this, 'McpAtlassianImage', {
      directory: path.join(__dirname, '../../'),
      file: 'Dockerfile',
      platform: Platform.LINUX_AMD64,
      exclude: ['cdk', 'cdk.out', 'node_modules', '.git', '.github'],
    });

    // ----------------------------------------------------------------
    // ECS Cluster
    // ----------------------------------------------------------------
    const cluster = new ecs.Cluster(this, 'McpCluster', {
      clusterName: 'mcp-atlassian-cluster',
      vpc,
      enableFargateCapacityProviders: true,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ----------------------------------------------------------------
    // Security Group — only allow inbound from configured CIDR
    // ----------------------------------------------------------------
    const mcpSG = new ec2.SecurityGroup(this, 'McpSecurityGroup', {
      securityGroupName: 'mcp-atlassian-sg',
      description: 'MCP Atlassian server — inbound from LangBuilder only',
      vpc,
    });
    mcpSG.addIngressRule(
      ec2.Peer.ipv4(allowedCidr),
      ec2.Port.tcp(MCP_PORT),
      'Allow MCP traffic from LangBuilder'
    );

    // ----------------------------------------------------------------
    // CloudWatch Log Group
    // ----------------------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'McpLogGroup', {
      logGroupName: '/ecs/mcp-atlassian',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    // ----------------------------------------------------------------
    // IAM Roles
    // ----------------------------------------------------------------
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy'
        ),
      ],
    });

    // Allow execution role to pull secrets
    atlassianSecret.grantRead(taskExecutionRole);

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // ----------------------------------------------------------------
    // Fargate Task Definition — minimal resources
    // ----------------------------------------------------------------
    const taskDef = new ecs.FargateTaskDefinition(this, 'McpTaskDef', {
      memoryLimitMiB: 512,
      cpu: 256, // 0.25 vCPU
      executionRole: taskExecutionRole,
      taskRole,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
      },
    });

    taskDef.addContainer('mcp-atlassian', {
      image: ecs.ContainerImage.fromDockerImageAsset(dockerImage),
      containerName: 'mcp-atlassian',
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'mcp',
        logGroup,
      }),
      portMappings: [
        {
          containerPort: MCP_PORT,
          protocol: ecs.Protocol.TCP,
        },
      ],
      secrets: {
        JIRA_URL: ecs.Secret.fromSecretsManager(atlassianSecret, 'JIRA_URL'),
        JIRA_USERNAME: ecs.Secret.fromSecretsManager(atlassianSecret, 'JIRA_USERNAME'),
        JIRA_API_TOKEN: ecs.Secret.fromSecretsManager(atlassianSecret, 'JIRA_API_TOKEN'),
        CONFLUENCE_URL: ecs.Secret.fromSecretsManager(atlassianSecret, 'CONFLUENCE_URL'),
        CONFLUENCE_USERNAME: ecs.Secret.fromSecretsManager(atlassianSecret, 'CONFLUENCE_USERNAME'),
        CONFLUENCE_API_TOKEN: ecs.Secret.fromSecretsManager(atlassianSecret, 'CONFLUENCE_API_TOKEN'),
      },
      command: ['--transport', 'http', '--port', MCP_PORT.toString()],
      healthCheck: {
        command: ['CMD-SHELL', `wget -qO- http://localhost:${MCP_PORT}/mcp || exit 1`],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(15),
      },
    });

    // ----------------------------------------------------------------
    // ECS Fargate Service
    // ----------------------------------------------------------------
    const service = new ecs.FargateService(this, 'McpService', {
      cluster,
      serviceName: 'mcp-atlassian',
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [mcpSG],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableExecuteCommand: true, // allows `aws ecs execute-command` for debugging
      circuitBreaker: { enable: true, rollback: true },
    });

    // ----------------------------------------------------------------
    // Service Discovery (optional — allows DNS-based access within VPC)
    // ----------------------------------------------------------------
    const namespace = cluster.addDefaultCloudMapNamespace({
      name: 'mcp.internal',
      vpc,
    });

    service.enableCloudMap({
      name: 'atlassian',
      // Accessible at: atlassian.mcp.internal:9000
    });

    // ----------------------------------------------------------------
    // Outputs
    // ----------------------------------------------------------------
    new cdk.CfnOutput(this, 'SecretArn', {
      value: atlassianSecret.secretArn,
      description: 'ARN of the Atlassian credentials secret — update via AWS Console or CLI',
    });

    new cdk.CfnOutput(this, 'ServiceDiscoveryEndpoint', {
      value: `atlassian.mcp.internal:${MCP_PORT}`,
      description: 'Internal DNS endpoint for the MCP server (from within the VPC)',
    });

    new cdk.CfnOutput(this, 'EcrRepoUri', {
      value: ecrRepo.repositoryUri,
      description: 'ECR repository URI for pushing custom images',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
      description: 'ECS cluster name (for aws ecs execute-command debugging)',
    });
  }
}
