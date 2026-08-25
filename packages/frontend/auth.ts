import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { loginWithCognito } from "@/lib/cognito";

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: {
    strategy: "jwt"
  },
  pages: {
    signIn: "/"
  },
  providers: [
    Credentials({
      name: "Cognito",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" }
      },
      authorize: async (credentials) => loginWithCognito(credentials)
    })
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.groups = user.groups;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.sub ?? "";
      session.user.groups = Array.isArray(token.groups) ? token.groups : [];
      return session;
    }
  }
});
