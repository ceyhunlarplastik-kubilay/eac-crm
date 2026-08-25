const region = aws.getRegionOutput({}).region;

export const userPool = new sst.aws.CognitoUserPool("UserPool", {
  usernames: ["email"],
  transform: {
    userPool: {
      adminCreateUserConfig: {
        allowAdminCreateUserOnly: true
      },
      autoVerifiedAttributes: ["email"]
    }
  }
});

export const adminGroup = new aws.cognito.UserGroup("AdminGroup", {
  userPoolId: userPool.id,
  name: "admin",
  description: "CRM admin users",
  precedence: 1
});

export const userPoolClient = userPool.addClient("WebClient", {
  transform: {
    client: {
      generateSecret: false,
      explicitAuthFlows: [
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH"
      ],
      preventUserExistenceErrors: "ENABLED",
      accessTokenValidity: 60,
      idTokenValidity: 60,
      refreshTokenValidity: 30,
      tokenValidityUnits: {
        accessToken: "minutes",
        idToken: "minutes",
        refreshToken: "days"
      },
      readAttributes: ["email", "name", "given_name", "family_name"],
      writeAttributes: ["email", "name", "given_name", "family_name"]
    }
  }
});

export const cognitoRegion = region;
