import { auth } from "@/auth";
import { DashboardShell } from "@/components/dashboard-shell";
import { LoginForm } from "@/components/login-form";

export default async function Home() {
  const session = await auth();
  const isAdmin = session?.user?.groups.includes("admin");

  if (!session?.user || !isAdmin) {
    return <LoginForm />;
  }

  return (
    <DashboardShell
      user={{
        name: session.user.name ?? "Admin",
        email: session.user.email ?? ""
      }}
    />
  );
}
