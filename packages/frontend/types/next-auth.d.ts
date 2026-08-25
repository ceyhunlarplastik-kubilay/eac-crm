import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      groups: string[];
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }

  interface User {
    groups: string[];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    groups?: string[];
  }
}
