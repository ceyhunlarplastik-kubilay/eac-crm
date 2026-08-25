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

    return {
      web: frontend.url,
      userPoolId: userPool.id,
      userPoolClientId: userPoolClient.id,
      adminGroupName: adminGroup.name
    };
  },
});
