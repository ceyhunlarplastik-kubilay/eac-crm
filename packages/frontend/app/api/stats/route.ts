import { buildCustomerWhere, hasCustomerFilters } from "@/lib/customer-filters";
import { prisma } from "@/lib/prisma";
import { jsonError, requireAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const timeZone = process.env.APP_TIME_ZONE ?? "Europe/Istanbul";

function parseDate(value: string | null, fallback: Date) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function dayKey(value: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);

  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";

  return `${year}-${month}-${day}`;
}

export async function GET(request: Request) {
  try {
    await requireAdmin();

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const url = new URL(request.url);
    const start = parseDate(url.searchParams.get("start"), startOfDay);
    const end = parseDate(url.searchParams.get("end"), now);
    const customerWhere = buildCustomerWhere(url.searchParams);
    const isFiltered = hasCustomerFilters(url.searchParams);

    const customers = await prisma.customer.findMany({
      where: customerWhere,
      select: {
        id: true,
        city: true,
        reached: true,
        interestStatus: true,
        catalogSent: true,
        sampleStatus: true,
        updatedAt: true
      }
    });

    const customerIds = customers.map((customer) => customer.id);
    const activityWhere = {
      createdAt: {
        gte: start,
        lte: end
      },
      ...(isFiltered ? { customerId: { in: customerIds } } : {})
    };

    const [activityCount, activities] = await Promise.all([
      prisma.activityLog.count({
        where: activityWhere
      }),
      prisma.activityLog.findMany({
        where: activityWhere,
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          customerId: true,
          action: true,
          summary: true,
          actorEmail: true,
          actorName: true,
          createdAt: true
        }
      })
    ]);

    const byCity = Object.entries(
      customers.reduce<Record<string, number>>((acc, customer) => {
        const city = customer.city ?? "Belirsiz";
        acc[city] = (acc[city] ?? 0) + 1;
        return acc;
      }, {})
    )
      .map(([city, count]) => ({ city, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const workByDay = Object.entries(
      activities.reduce<Record<string, number>>((acc, activity) => {
        const key = dayKey(activity.createdAt);
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {})
    ).map(([date, count]) => ({ date, count }));

    const workByActor = Object.entries(
      activities.reduce<Record<string, number>>((acc, activity) => {
        const actor = activity.actorName ?? activity.actorEmail ?? "Bilinmeyen";
        acc[actor] = (acc[actor] ?? 0) + 1;
        return acc;
      }, {})
    )
      .map(([actor, count]) => ({ actor, count }))
      .sort((a, b) => b.count - a.count);

    return Response.json({
      range: {
        start: start.toISOString(),
        end: end.toISOString()
      },
      totals: {
        customers: customers.length,
        reached: customers.filter((customer) => customer.reached === "REACHED").length,
        interested: customers.filter(
          (customer) => customer.interestStatus === "INTERESTED"
        ).length,
        catalogSent: customers.filter((customer) => customer.catalogSent === true).length,
        samplesToSend: customers.filter(
          (customer) => customer.sampleStatus === "WILL_SEND"
        ).length,
        samplesSent: customers.filter((customer) => customer.sampleStatus === "SENT").length,
        activityCount,
        touchedCustomers: new Set(
          activities.map((activity) => activity.customerId).filter(Boolean)
        ).size
      },
      byCity,
      workByDay,
      workByActor,
      recentActivity: activities
        .slice(-12)
        .reverse()
        .map((activity) => ({
          ...activity,
          createdAt: activity.createdAt.toISOString()
        }))
    });
  } catch (error) {
    return jsonError(error);
  }
}
