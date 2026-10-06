const region = aws.getRegionOutput({}).region;
const account = aws.getCallerIdentityOutput({}).accountId;
const databaseUrl = process.env.DATABASE_URL ?? "";
const enabled = process.env.POST_CALL_ANALYTICS_ENABLED !== "false";
const modelId = process.env.BEDROCK_MODEL_ID ?? "eu.amazon.nova-lite-v1:0";
const foundationModelId = modelId.replace(/^(eu|us|apac|global)\./, "");

function createCallAnalytics() {
  if (!databaseUrl) throw new Error("Post-call analytics için DATABASE_URL gerekli.");

  const recordings = new sst.aws.Bucket("CallRecordings", { cors: false, enforceHttps: true });
  const catalogs = new sst.aws.Bucket("SalesCatalogs", { cors: false, enforceHttps: true, versioning: true });

  for (const [name, bucket] of [["RecordingsEncryption", recordings], ["CatalogsEncryption", catalogs]] as const) {
    new aws.s3.BucketServerSideEncryptionConfiguration(name, {
      bucket: bucket.name,
      rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }]
    }, { aliases: [{ type: "aws:s3/bucketServerSideEncryptionConfigurationV2:BucketServerSideEncryptionConfigurationV2" }] });
  }
  new aws.s3.BucketNotification("RecordingEvents", { bucket: recordings.name, eventbridge: true });

  const vectors = new aws.s3.VectorsVectorBucket("CatalogVectors", {
    vectorBucketName: $interpolate`${$app.name}-${$app.stage}-${account}-catalog-vectors`
  });
  const index = new aws.s3.VectorsIndex("CatalogVectorIndex", {
    vectorBucketName: vectors.vectorBucketName, indexName: "sales-catalog",
    dataType: "float32", dimension: 1024, distanceMetric: "cosine",
    metadataConfiguration: { nonFilterableMetadataKeys: ["AMAZON_BEDROCK_TEXT", "AMAZON_BEDROCK_METADATA"] }
  });
  const knowledgeRole = new aws.iam.Role("CatalogKnowledgeRole", {
    assumeRolePolicy: $jsonStringify({
      Version: "2012-10-17", Statement: [{
        Effect: "Allow", Principal: { Service: "bedrock.amazonaws.com" }, Action: "sts:AssumeRole",
        Condition: { StringEquals: { "aws:SourceAccount": account }, ArnLike: { "aws:SourceArn": $interpolate`arn:aws:bedrock:${region}:${account}:knowledge-base/*` } }
      }]
    })
  });
  const knowledgePolicy = new aws.iam.RolePolicy("CatalogKnowledgePermissions", {
    role: knowledgeRole.id,
    policy: $jsonStringify({
      Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: ["bedrock:InvokeModel"], Resource: $interpolate`arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0` },
        { Effect: "Allow", Action: ["s3:ListBucket"], Resource: catalogs.arn, Condition: { StringLike: { "s3:prefix": ["catalogs/*"] } } },
        { Effect: "Allow", Action: ["s3:GetObject"], Resource: $interpolate`${catalogs.arn}/catalogs/*` },
        { Effect: "Allow", Action: ["s3vectors:PutVectors", "s3vectors:GetVectors", "s3vectors:DeleteVectors", "s3vectors:QueryVectors", "s3vectors:GetIndex"], Resource: index.indexArn }
      ]
    })
  });
  const knowledgeBase = new aws.bedrock.AgentKnowledgeBase("SalesKnowledgeBase", {
    name: `${$app.name}-${$app.stage}-sales-catalog`, roleArn: knowledgeRole.arn,
    knowledgeBaseConfiguration: {
      type: "VECTOR", vectorKnowledgeBaseConfiguration: {
        embeddingModelArn: $interpolate`arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`,
        embeddingModelConfiguration: { bedrockEmbeddingModelConfiguration: { dimensions: 1024, embeddingDataType: "FLOAT32" } }
      }
    },
    storageConfiguration: { type: "S3_VECTORS", s3VectorsConfiguration: { indexArn: index.indexArn } }
  }, { dependsOn: [knowledgePolicy, index] });
  const dataSource = new aws.bedrock.AgentDataSource("SalesCatalogDataSource", {
    knowledgeBaseId: knowledgeBase.id, name: "sales-catalogs", dataDeletionPolicy: "RETAIN",
    dataSourceConfiguration: { type: "S3", s3Configuration: { bucketArn: catalogs.arn, inclusionPrefixes: ["catalogs/"] } },
    vectorIngestionConfiguration: { chunkingConfiguration: { chunkingStrategy: "FIXED_SIZE", fixedSizeChunkingConfiguration: { maxTokens: 450, overlapPercentage: 15 } } }
  });

  const transcribeRole = new aws.iam.Role("RecordingTranscribeRole", {
    assumeRolePolicy: $jsonStringify({
      Version: "2012-10-17", Statement: [{
        Effect: "Allow", Principal: { Service: "transcribe.amazonaws.com" }, Action: "sts:AssumeRole",
        Condition: { StringEquals: { "aws:SourceAccount": account }, ArnLike: { "aws:SourceArn": $interpolate`arn:aws:transcribe:${region}:${account}:transcription-job/*` } }
      }]
    })
  });
  new aws.iam.RolePolicy("RecordingTranscribePermissions", {
    role: transcribeRole.id,
    policy: $jsonStringify({
      Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: ["s3:GetObject"], Resource: $interpolate`${recordings.arn}/audio/*` },
        { Effect: "Allow", Action: ["s3:PutObject"], Resource: $interpolate`${recordings.arn}/transcripts/*` },
        { Effect: "Allow", Action: ["s3:GetBucketLocation"], Resource: recordings.arn }
      ]
    })
  });
  const environment = { DATABASE_URL: databaseUrl, RECORDINGS_BUCKET_NAME: recordings.name };

  const prepare = new sst.aws.Function("PrepareCallRecording", {
    handler: "packages/call-analytics/src/workflow.prepare", environment, timeout: "45 seconds", memory: "512 MB",
    permissions: [{ actions: ["s3:GetObject"], resources: [$interpolate`${recordings.arn}/audio/*`] }]
  });

  const start = new sst.aws.Function("StartCallTranscription", {
    handler: "packages/call-analytics/src/workflow.startTranscription",
    environment: { TRANSCRIBE_DATA_ROLE_ARN: transcribeRole.arn }, timeout: "45 seconds", memory: "512 MB",
    permissions: [
      { actions: ["transcribe:StartTranscriptionJob"], resources: [$interpolate`arn:aws:transcribe:${region}:${account}:transcription-job/eac-call-*`] },
      { actions: ["iam:PassRole"], resources: [transcribeRole.arn] },
      { actions: ["s3:GetObject"], resources: [$interpolate`${recordings.arn}/audio/*`] },
      { actions: ["s3:PutObject"], resources: [$interpolate`${recordings.arn}/transcripts/*`] },
      { actions: ["s3:GetBucketLocation"], resources: [recordings.arn] }
    ]
  });

  const poll = new sst.aws.Function("PollCallTranscription", {
    handler: "packages/call-analytics/src/workflow.pollTranscription", timeout: "30 seconds", memory: "256 MB",
    permissions: [{ actions: ["transcribe:GetTranscriptionJob"], resources: [$interpolate`arn:aws:transcribe:${region}:${account}:transcription-job/eac-call-*`] }]
  });

  const analyze = new sst.aws.Function("AnalyzeSalesCall", {
    handler: "packages/call-analytics/src/workflow.analyze", timeout: "5 minutes", memory: "1024 MB",
    environment: { ...environment, CATALOG_KNOWLEDGE_BASE_ID: knowledgeBase.id, BEDROCK_MODEL_ID: modelId },
    permissions: [
      { actions: ["s3:GetObject"], resources: [$interpolate`${recordings.arn}/transcripts/*`] },
      { actions: ["bedrock:Retrieve"], resources: [knowledgeBase.arn] },
      {
        actions: ["bedrock:InvokeModel"], resources: [
          $interpolate`arn:aws:bedrock:*::foundation-model/${foundationModelId}`,
          $interpolate`arn:aws:bedrock:${region}:${account}:inference-profile/${modelId}`
        ]
      }
    ]
  });

  const failure = new sst.aws.Function("FailCallRecording", { handler: "packages/call-analytics/src/workflow.failed", environment, timeout: "45 seconds" });
  const terminal = new sst.aws.Function("HandleCallExecutionFailure", { handler: "packages/call-analytics/src/workflow.terminalExecution", environment, timeout: "45 seconds" });
  const stateRole = new aws.iam.Role("CallWorkflowRole", {
    assumeRolePolicy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] })
  });
  const statePolicy = new aws.iam.RolePolicy("CallWorkflowPermissions", {
    role: stateRole.id,
    policy: $jsonStringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [prepare.arn, start.arn, poll.arn, analyze.arn, failure.arn] }] })
  });
  const retry = [{ ErrorEquals: ["States.TaskFailed"], IntervalSeconds: 10, MaxAttempts: 2, BackoffRate: 2 }];
  const catcher = [{ ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: "RecordFailure" }];

  const stateMachine = new aws.sfn.StateMachine("PostCallAnalysis", {
    type: "STANDARD", roleArn: stateRole.arn,
    definition: $jsonStringify({
      Comment: "Transcribe tr-TR, catalog retrieval and Bedrock sales analysis. Payloads contain identifiers only.",
      StartAt: "Prepare", TimeoutSeconds: 14400,
      States: {
        Prepare: { Type: "Task", Resource: prepare.arn, Parameters: { "input.$": "$", "executionArn.$": "$$.Execution.Id" }, ResultPath: "$.job", Retry: retry, Catch: catcher, Next: "Claimed" },
        Claimed: { Type: "Choice", Choices: [{ Variable: "$.job", IsNull: true, Next: "Ignored" }], Default: "ResumeOrTranscribe" },
        ResumeOrTranscribe: { Type: "Choice", Choices: [{ Variable: "$.job.reuseTranscript", BooleanEquals: true, Next: "Analyze" }], Default: "StartTranscription" },
        StartTranscription: { Type: "Task", Resource: start.arn, Parameters: { "job.$": "$.job" }, ResultPath: "$.started", Retry: retry, Catch: catcher, Next: "WaitForTranscript" },
        WaitForTranscript: { Type: "Wait", Seconds: 30, Next: "GetTranscriptionStatus" },
        GetTranscriptionStatus: { Type: "Task", Resource: poll.arn, Parameters: { "job.$": "$.job" }, ResultPath: "$.transcription", Retry: retry, Catch: catcher, Next: "TranscriptReady" },
        TranscriptReady: { Type: "Choice", Choices: [{ Variable: "$.transcription.status", StringEquals: "COMPLETED", Next: "Analyze" }], Default: "WaitForTranscript" },
        Analyze: { Type: "Task", Resource: analyze.arn, Parameters: { "job.$": "$.job" }, ResultPath: "$.result", Retry: retry, Catch: catcher, Next: "Completed" },
        RecordFailure: { Type: "Task", Resource: failure.arn, Parameters: { "input.$": "$", "executionArn.$": "$$.Execution.Id" }, ResultPath: null, Retry: retry, Next: "ProcessingFailed" },
        ProcessingFailed: { Type: "Fail", Error: "CallProcessingFailed", Cause: "Recording failed; see CRM for a safe error message." },
        Completed: { Type: "Succeed" }, Ignored: { Type: "Succeed" }
      }
    })
  }, { dependsOn: [statePolicy] });

  const eventRole = new aws.iam.Role("CallRecordingEventRole", {
    assumeRolePolicy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sts:AssumeRole" }] })
  });

  const eventPolicy = new aws.iam.RolePolicy("CallRecordingEventPermissions", {
    role: eventRole.id,
    policy: $jsonStringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["states:StartExecution"], Resource: stateMachine.arn }] })
  });

  const uploadEvents = new aws.cloudwatch.EventRule("CallAudioCreated", {
    eventPattern: $jsonStringify({ source: ["aws.s3"], "detail-type": ["Object Created"], detail: { bucket: { name: [recordings.name] }, object: { key: [{ prefix: "audio/" }] } } })
  });

  const deadLetters = new aws.sqs.Queue("CallEventDeadLetters", { messageRetentionSeconds: 1209600, sqsManagedSseEnabled: true });

  const deadLetterPolicy = new aws.sqs.QueuePolicy("CallEventDeadLetterPolicy", {
    queueUrl: deadLetters.url,
    policy: $jsonStringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sqs:SendMessage", Resource: deadLetters.arn, Condition: { ArnEquals: { "aws:SourceArn": uploadEvents.arn } } }] })
  });

  new aws.cloudwatch.EventTarget("StartCallFromUpload", {
    rule: uploadEvents.name, arn: stateMachine.arn, roleArn: eventRole.arn,
    deadLetterConfig: { arn: deadLetters.arn }, retryPolicy: { maximumEventAgeInSeconds: 86400, maximumRetryAttempts: 185 }
  }, { dependsOn: [eventPolicy, deadLetterPolicy] });

  const terminalEvents = new aws.cloudwatch.EventRule("CallExecutionFailed", {
    eventPattern: $jsonStringify({ source: ["aws.states"], "detail-type": ["Step Functions Execution Status Change"], detail: { stateMachineArn: [stateMachine.arn], status: ["FAILED", "TIMED_OUT", "ABORTED"] } })
  });

  new aws.lambda.Permission("CallTerminalEventPermission", { action: "lambda:InvokeFunction", function: terminal.name, principal: "events.amazonaws.com", sourceArn: terminalEvents.arn });
  new aws.cloudwatch.EventTarget("PersistCallTerminalFailure", { rule: terminalEvents.name, arn: terminal.arn });

  const uploadApi = new sst.aws.ApiGatewayV2("CallRecordingApi", { cors: false });

  const apiHandler = new sst.aws.Function("CallRecordingApiHandler", {
    handler: "packages/call-analytics/src/upload-api.handler", timeout: "28 seconds", memory: "512 MB",
    environment: { ...environment, CALL_ANALYTICS_STATE_MACHINE_ARN: stateMachine.arn, CUSTOMER_WRITES_PAUSED: process.env.CUSTOMER_WRITES_PAUSED ?? "false" },
    permissions: [
      { actions: ["s3:PutObject", "s3:GetObject"], resources: [$interpolate`${recordings.arn}/audio/*`] },
      { actions: ["states:StartExecution"], resources: [stateMachine.arn] }
    ]
  });

  for (const route of ["POST /recordings", "POST /recordings/{id}/dispatch", "POST /recordings/{id}/retry", "GET /recordings/{id}/playback"]) {
    uploadApi.route(route, apiHandler.arn, { auth: { iam: true } });
  }
  return { recordings, catalogs, knowledgeBase, dataSource, stateMachine, uploadApi, deadLetters, region };
}

export const callAnalytics = enabled ? createCallAnalytics() : null;

// Configured after Next.js: its URL depends on the API, so keep bucket CORS out of that dependency chain.
export function configureRecordingCors(frontendUrl: $util.Input<string>) {
  if (!callAnalytics) return;
  new aws.s3.BucketCorsConfiguration("CallRecordingCors", {
    bucket: callAnalytics.recordings.name,
    corsRules: [{
      allowedMethods: ["PUT", "GET", "HEAD"], allowedHeaders: ["content-type", "if-none-match", "x-amz-*"],
      allowedOrigins: $util.output(frontendUrl).apply((url) => Array.from(new Set([
        new URL(url).origin, ...($dev ? ["http://localhost:3000"] : []),
        ...(process.env.CALL_RECORDINGS_ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean)
      ]))), exposeHeaders: ["ETag"], maxAgeSeconds: 300
    }]
  });
}
