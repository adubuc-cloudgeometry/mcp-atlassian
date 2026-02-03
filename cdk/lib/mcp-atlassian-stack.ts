import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_logs as logs,
  aws_elasticloadbalancingv2 as elbv2,
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
    // ECR Repository
    // ----------------------------------------------------------------
    const ecrRepo = new ecr.Repository(this, 'McpAtlassianRepo', {
      repositoryName: 'mcp-atlassian',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
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
      description: 'MCP Atlassian server - inbound from LangBuilder only',
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
      environment: {
        // Per-request auth mode: each request carries user credentials
        // via Authorization: Basic header. No shared credentials on server.
        ATLASSIAN_OAUTH_ENABLE: 'true',
        // Base URLs are needed so the server knows which Atlassian instance
        // to connect to. No credentials — auth comes from per-request headers.
        JIRA_URL: 'https://cloudgeometry.atlassian.net',
        CONFLUENCE_URL: 'https://cloudgeometry.atlassian.net/wiki',
      },
      command: ['--transport', 'streamable-http', '--host', '0.0.0.0', '--port', MCP_PORT.toString()],
      healthCheck: {
        command: ['CMD-SHELL', `wget -qO- http://localhost:${MCP_PORT}/healthz || exit 1`],
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
    // Application Load Balancer — public internet access
    // ----------------------------------------------------------------
    const alb = new elbv2.ApplicationLoadBalancer(this, 'McpAlb', {
      loadBalancerName: 'mcp-atlassian-alb',
      vpc,
      internetFacing: true,
    });

    const listener = alb.addListener('McpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    listener.addTargets('McpTargets', {
      port: MCP_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: '/healthz',
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Allow ALB to reach the ECS service
    service.connections.allowFrom(alb, ec2.Port.tcp(MCP_PORT), 'Allow ALB to reach MCP server');

    // ----------------------------------------------------------------
    // Service Discovery (optional — allows DNS-based access within VPC)
    // ----------------------------------------------------------------
    cluster.addDefaultCloudMapNamespace({
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
    new cdk.CfnOutput(this, 'AlbEndpoint', {
      value: `http://${alb.loadBalancerDnsName}`,
      description: 'Public URL for the MCP server (use as MCP Server URL in LangBuilder)',
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
