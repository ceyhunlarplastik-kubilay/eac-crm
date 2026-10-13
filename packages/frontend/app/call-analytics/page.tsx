import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { CallAnalyticsPanel } from "@/components/call-analytics-panel";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function CallAnalyticsPage({ searchParams }: { searchParams: Promise<{ customerId?: string }> }) {
  const session = await auth();
  if (!session?.user?.groups.includes("admin")) redirect("/");
  const { customerId } = await searchParams;
  const initialCustomer = typeof customerId === "string" && customerId.length <= 100 ? await prisma.customer.findFirst({
    where: { id: customerId, deletedAt: null }, select: { id: true, companyName: true, city: true }
  }) : null;
  return <CallAnalyticsPanel user={{ name: session.user.name ?? "Admin", email: session.user.email ?? "" }} initialCustomer={initialCustomer}
    configured={Boolean(process.env.CALL_RECORDING_API_URL)} />;
}
