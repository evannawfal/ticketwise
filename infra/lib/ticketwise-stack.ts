import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction, OutputFormat, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Trigger } from "aws-cdk-lib/triggers";
import type { Construct } from "constructs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export interface TicketwiseStackProps extends StackProps {
  llmProvider: "bedrock" | "openai" | "local";
  embeddingProvider: "bedrock" | "openai" | "local";
  embeddingDim: number;
  /** Secrets Manager secret holding DATABASE_URL, ADMIN_TOKEN, Slack + OpenAI keys. */
  secretName: string;
  bedrockModelId?: string;
}

export class TicketwiseStack extends Stack {
  constructor(scope: Construct, id: string, props: TicketwiseStackProps) {
    super(scope, id, props);

    // Created before deploy with scripts/create-secret.sh so values never touch CloudFormation.
    const secret = secretsmanager.Secret.fromSecretNameV2(this, "AppSecret", props.secretName);

    // ---------- Admin site (static Next.js export on S3 + CloudFront) ----------
    const siteBucket = new s3.Bucket(this, "AdminBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const distribution = new cloudfront.Distribution(this, "AdminCdn", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",
      errorResponses: [{ httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" }],
    });
    const adminUrl = `https://${distribution.distributionDomainName}`;

    // ---------- Lambdas ----------
    const queueDlq = new sqs.Queue(this, "SlackJobsDlq", { retentionPeriod: Duration.days(14) });
    const queue = new sqs.Queue(this, "SlackJobs", {
      visibilityTimeout: Duration.seconds(90),
      deadLetterQueue: { queue: queueDlq, maxReceiveCount: 3 },
    });

    const environment: Record<string, string> = {
      APP_SECRET_ARN: secret.secretArn,
      LLM_PROVIDER: props.llmProvider,
      EMBEDDING_PROVIDER: props.embeddingProvider,
      EMBEDDING_DIM: String(props.embeddingDim),
      SLACK_QUEUE_URL: queue.queueUrl,
      ALLOWED_ORIGIN: adminUrl,
      NODE_OPTIONS: "--enable-source-maps",
    };
    if (props.bedrockModelId) environment.BEDROCK_MODEL_ID = props.bedrockModelId;

    const common: NodejsFunctionProps = {
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(29),
      environment,
      logRetention: RetentionDays.TWO_WEEKS,
      bundling: {
        format: OutputFormat.ESM,
        target: "node22",
        sourceMap: true,
        // pg optionally requires pg-native; we don't use it.
        externalModules: ["@aws-sdk/*", "pg-native"],
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      depsLockFilePath: join(root, "package-lock.json"),
    };
    const fn = (name: string, file: string, extra: Partial<NodejsFunctionProps> = {}) =>
      new NodejsFunction(this, name, { ...common, ...extra, entry: join(root, "services/api/src/handlers", file), handler: "handler" });

    const apiFn = fn("ApiFn", "api.ts");
    const slackFn = fn("SlackFn", "slack.ts", { memorySize: 256, timeout: Duration.seconds(5) });
    const workerFn = fn("WorkerFn", "worker.ts", { timeout: Duration.seconds(60) });
    const migrateFn = fn("MigrateFn", "migrate.ts", { timeout: Duration.seconds(60) });

    for (const f of [apiFn, slackFn, workerFn, migrateFn]) secret.grantRead(f);
    queue.grantSendMessages(slackFn);
    workerFn.addEventSource(new SqsEventSource(queue, { batchSize: 1, reportBatchItemFailures: true }));

    if (props.llmProvider === "bedrock" || props.embeddingProvider === "bedrock") {
      const bedrock = new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          "arn:aws:bedrock:*::foundation-model/*",
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      });
      for (const f of [apiFn, workerFn]) f.addToRolePolicy(bedrock);
    }

    // Create tables after every deploy (idempotent CREATE ... IF NOT EXISTS).
    new Trigger(this, "MigrateTrigger", { handler: migrateFn, executeOnHandlerChange: true });

    // ---------- HTTP API ----------
    const httpApi = new HttpApi(this, "HttpApi", { description: "Ticketwise REST API and Slack endpoint" });
    httpApi.addRoutes({ path: "/slack/events", methods: [HttpMethod.POST], integration: new HttpLambdaIntegration("SlackInt", slackFn) });
    httpApi.addRoutes({ path: "/{proxy+}", methods: [HttpMethod.ANY], integration: new HttpLambdaIntegration("ApiInt", apiFn) });
    const apiUrl = httpApi.apiEndpoint;

    // ---------- Upload admin build + runtime config ----------
    const adminOut = join(root, "apps/admin/out");
    if (existsSync(adminOut)) {
      new s3deploy.BucketDeployment(this, "AdminDeploy", {
        destinationBucket: siteBucket,
        distribution,
        sources: [s3deploy.Source.asset(adminOut), s3deploy.Source.jsonData("config.json", { apiUrl })],
      });
    }

    new CfnOutput(this, "AdminUrl", { value: adminUrl });
    new CfnOutput(this, "ApiUrl", { value: apiUrl });
    new CfnOutput(this, "SlackRequestUrl", { value: `${apiUrl}/slack/events`, description: "Use for Slash Commands and Event Subscriptions" });
    new CfnOutput(this, "DeadLetterQueue", { value: queueDlq.queueName });
  }
}
