import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { googleAuthEnvironment } from "./google-auth";

const region = aws.getRegionOutput({}).region;
const account = aws.getCallerIdentityOutput({}).accountId;
const databaseUrl = process.env.DATABASE_URL ?? "";
const enabled = process.env.POST_CALL_ANALYTICS_ENABLED !== "false";
const googleProject = process.env.GOOGLE_CLOUD_PROJECT ?? "";
const modelId = process.env.GEMINI_MODEL_ID ?? "gemini-3.1-flash-lite";
const wifPath = resolve(process.env.GOOGLE_WIF_CONFIG_PATH ?? `.local/google/wif-${$app.stage}.json`);

function createCallAnalytics() {
  const wif = existsSync(wifPath) ? JSON.parse(readFileSync(wifPath, "utf8")) : null;
  if (!databaseUrl) throw new Error("Post-call analytics için DATABASE_URL gerekli.");
  if (!googleProject) throw new Error("Post-call analytics için GOOGLE_CLOUD_PROJECT gerekli.");
  if (!$dev && !wif) throw new Error("Deploy öncesi google:federation --stage ile WIF hazırlayın. Ayrıntılar docs/post-call-analytics.md içinde.");
  if (wif && (!wif.audience?.includes(`/workloadIdentityPools/eac-crm-${$app.stage}/`)
    || !wif.service_account_impersonation_url?.endsWith(`@${googleProject}.iam.gserviceaccount.com:generateAccessToken`))) {
    throw new Error("Google WIF dosyası seçili SST stage / Google projesiyle eşleşmiyor.");
  }
  const googleAuth = googleAuthEnvironment($dev, wif);

  const recordings = new sst.aws.Bucket("CallRecordings", { cors: false, enforceHttps: true });
  const catalogs = new sst.aws.Bucket("SalesCatalogs", { cors: false, enforceHttps: true, versioning: true });

  for (const [name, bucket] of [["RecordingsEncryption", recordings], ["CatalogsEncryption", catalogs]] as const) {
    new aws.s3.BucketServerSideEncryptionConfiguration(name, {
      bucket: bucket.name,
      rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }]
    }, { aliases: [{ type: "aws:s3/bucketServerSideEncryptionConfigurationV2:BucketServerSideEncryptionConfigurationV2" }] });
  }
  new aws.s3.BucketNotification("RecordingEvents", { bucket: recordings.name, eventbridge: true });

  const transcribeRole = new aws.iam.Role("RecordingTranscribeRole", {
    assumeRolePolicy: $jsonStringify({
      Version: "2012-10-17", Statement: [{
        Effect: "Allow", Principal: { Service: "transcribe.amazonaws.com" }, Action: "sts:AssumeRole",
        Condition: { StringEquals: { "aws:SourceAccount": account }, ArnLike: { "aws:SourceArn": $interpolate`arn:aws:transcribe:${region}:${account}:*` } }
      }]
    })
  });
  const transcribePolicy = new aws.iam.RolePolicy("RecordingTranscribePermissions", {
    role: transcribeRole.id,
    policy: $jsonStringify({
      Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: ["s3:GetObject"], Resource: $interpolate`${recordings.arn}/audio/*` },
        { Effect: "Allow", Action: ["s3:PutObject"], Resource: $interpolate`${recordings.arn}/transcripts/*` },
        { Effect: "Allow", Action: ["s3:GetBucketLocation", "s3:ListBucket"], Resource: recordings.arn }
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
    // Keep this task on AWS during sst dev: Transcribe validates the caller's S3 output access.
    dev: false,
    environment: { TRANSCRIBE_DATA_ROLE_ARN: transcribeRole.arn }, timeout: "45 seconds", memory: "512 MB",
    permissions: [
      { actions: ["transcribe:StartTranscriptionJob"], resources: [$interpolate`arn:aws:transcribe:${region}:${account}:transcription-job/eac-call-*`] },
      { actions: ["iam:PassRole"], resources: [transcribeRole.arn] },
      { actions: ["s3:GetObject"], resources: [$interpolate`${recordings.arn}/audio/*`] },
      { actions: ["s3:PutObject"], resources: [$interpolate`${recordings.arn}/transcripts/*`] },
      { actions: ["s3:GetBucketLocation", "s3:ListBucket"], resources: [recordings.arn] }
    ]
  }, { dependsOn: [transcribePolicy] });

  const poll = new sst.aws.Function("PollCallTranscription", {
    handler: "packages/call-analytics/src/workflow.pollTranscription", timeout: "30 seconds", memory: "256 MB",
    permissions: [{ actions: ["transcribe:GetTranscriptionJob"], resources: [$interpolate`arn:aws:transcribe:${region}:${account}:transcription-job/eac-call-*`] }]
  });

  const analyze = new sst.aws.Function("AnalyzeSalesCall", {
    handler: "packages/call-analytics/src/workflow.analyze", timeout: "5 minutes", memory: "1024 MB",
    environment: { ...environment, GOOGLE_CLOUD_PROJECT: googleProject,
      GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION ?? "europe-west4",
      GEMINI_LOCATION: process.env.GEMINI_LOCATION ?? "eu", GEMINI_MODEL_ID: modelId,
      EMBEDDING_MODEL_ID: process.env.EMBEDDING_MODEL_ID ?? "gemini-embedding-001",
      ...googleAuth },
    permissions: [{ actions: ["s3:GetObject"], resources: [$interpolate`${recordings.arn}/transcripts/*`] }]
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
      Comment: "Transcribe tr-TR, Neon pgvector retrieval and Google Gemini sales analysis. Payloads contain identifiers only.",
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
  return { recordings, catalogs, analysisRoleArn: analyze.nodes.role.arn, googleProject, stateMachine, uploadApi, deadLetters, region };
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
