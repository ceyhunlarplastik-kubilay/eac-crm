import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand
} from "@aws-sdk/client-cognito-identity-provider";
import { z } from "zod";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

type CognitoJwtPayload = {
  sub: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  "cognito:groups"?: string[];
};

function decodeJwtPayload(token: string): CognitoJwtPayload {
  const payload = token.split(".")[1];
  if (!payload) {
    throw new Error("Cognito token payload okunamadı.");
  }

  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

export async function loginWithCognito(credentials: unknown) {
  const parsed = credentialsSchema.safeParse(credentials);

  if (!parsed.success) {
    return null;
  }

  const region = process.env.COGNITO_REGION;
  const clientId = process.env.COGNITO_CLIENT_ID;

  if (!region || !clientId) {
    throw new Error("Cognito environment variables are missing.");
  }

  const client = new CognitoIdentityProviderClient({ region });
  const result = await client.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: {
        USERNAME: parsed.data.email,
        PASSWORD: parsed.data.password
      }
    })
  );

  if (result.ChallengeName) {
    throw new Error("Cognito kullanıcısı için ek doğrulama veya şifre yenileme gerekiyor.");
  }

  const idToken = result.AuthenticationResult?.IdToken;

  if (!idToken) {
    return null;
  }

  const payload = decodeJwtPayload(idToken);
  const groups = payload["cognito:groups"] ?? [];

  if (!groups.includes("admin")) {
    throw new Error("Bu uygulamaya erişmek için admin grubunda olmanız gerekiyor.");
  }

  const nameFromParts =
    [payload.given_name, payload.family_name].filter(Boolean).join(" ") || null;
  const displayName = payload.name ?? nameFromParts ?? payload.email ?? parsed.data.email;

  return {
    id: payload.sub,
    email: payload.email ?? parsed.data.email,
    name: displayName,
    groups
  };
}
