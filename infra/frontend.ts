import { cognitoRegion, userPool, userPoolClient } from "./cognito";
import { callAnalytics } from "./call-analytics";

const databaseUrl = process.env.DATABASE_URL ?? "";
const authSecret = process.env.AUTH_SECRET ?? "dev-only-change-me";

if ($app.stage === "production" && (!databaseUrl || authSecret === "dev-only-change-me")) {
  throw new Error("DATABASE_URL and AUTH_SECRET must be set for production.");
}

export const frontend = new sst.aws.Nextjs("MyWeb", {
  path: "packages/frontend",
  environment: {
    APP_TIME_ZONE: "Europe/Istanbul",
    AUTH_SECRET: authSecret,
    AUTH_TRUST_HOST: "true",
    COGNITO_CLIENT_ID: userPoolClient.id,
    COGNITO_REGION: cognitoRegion,
    COGNITO_USER_POOL_ID: userPool.id,
    DATABASE_URL: databaseUrl,
    CUSTOMER_WRITES_PAUSED: process.env.CUSTOMER_WRITES_PAUSED ?? "false",
    ...(callAnalytics ? {
      CALL_RECORDING_API_URL: callAnalytics.uploadApi.url,
      CALL_ANALYTICS_REGION: callAnalytics.region
    } : {}),
    NEXT_PUBLIC_APP_STAGE: $app.stage
  },
  permissions: [
    ...(callAnalytics ? [{
      actions: ["execute-api:Invoke"],
      resources: [$interpolate`${callAnalytics.uploadApi.nodes.api.executionArn}/*/*/recordings*`]
    }] : []),
    {
      actions: [
        "cognito-idp:InitiateAuth",
        "cognito-idp:RespondToAuthChallenge"
      ],
      resources: [userPool.arn]
    }
  ]
});
