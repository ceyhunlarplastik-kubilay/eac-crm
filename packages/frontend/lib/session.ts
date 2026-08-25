import { auth } from "@/auth";

export type Actor = {
  sub: string;
  email: string | null;
  name: string | null;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export async function requireAdmin() {
  const session = await auth();

  if (!session?.user) {
    throw new ApiError(401, "Oturum gerekli.");
  }

  if (!session.user.groups.includes("admin")) {
    throw new ApiError(403, "Admin yetkisi gerekli.");
  }

  return {
    session,
    actor: {
      sub: session.user.id,
      email: session.user.email ?? null,
      name: session.user.name ?? null
    } satisfies Actor
  };
}

export function jsonError(error: unknown) {
  if (error instanceof ApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  if (error instanceof Error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ error: "Beklenmeyen hata." }, { status: 500 });
}
