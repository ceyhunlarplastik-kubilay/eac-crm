/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "eac-crm",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
    };
  },
  async run() {
    const { adminGroup, userPool, userPoolClient } = await import("./infra/cognito");
    const { frontend } = await import("./infra/frontend");
    const { callAnalytics, configureRecordingCors } = await import("./infra/call-analytics");
    configureRecordingCors(frontend.url);

    return {
      web: frontend.url,
      userPoolId: userPool.id,
      userPoolClientId: userPoolClient.id,
      adminGroupName: adminGroup.name,
      ...(callAnalytics ? {
        callRecordingsBucket: callAnalytics.recordings.name,
        salesCatalogBucket: callAnalytics.catalogs.name,
        callAnalysisRoleArn: callAnalytics.analysisRoleArn,
        googleCloudProject: callAnalytics.googleProject,
        callAnalyticsStateMachineArn: callAnalytics.stateMachine.arn,
        callRecordingApi: callAnalytics.uploadApi.url,
        callEventDeadLetterQueue: callAnalytics.deadLetters.url,
        callAnalyticsRegion: callAnalytics.region
      } : {})
    };
  },
});
