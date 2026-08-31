import { z } from "zod";
import {
  actorFields,
  contactMetrics,
  customerContactInclude,
  serializeCustomer
} from "@/lib/customer-service";
import { prisma } from "@/lib/prisma";
import { ApiError, jsonError, requireAdmin } from "@/lib/session";
import { normalizeText } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const contactCreateSchema = z.object({
  contactedAt: z.coerce.date().refine((value) => !Number.isNaN(value.getTime()), {
    message: "Geçerli görüşme tarihi gerekli."
  }),
  note: z.preprocess(normalizeText, z.string().max(1000).nullable()).optional()
});

function dateRangeForDay(date: Date) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return { start, end };
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { actor } = await requireAdmin();
    const { id } = await context.params;
    const parsed = contactCreateSchema.parse(await request.json());

    const existing = await prisma.customer.findFirst({
      where: { id, deletedAt: null }
    });

    if (!existing) {
      throw new ApiError(404, "Müşteri bulunamadı.");
    }

    const { start, end } = dateRangeForDay(parsed.contactedAt);
    const duplicate = await prisma.customerContact.findFirst({
      where: {
        customerId: id,
        contactedAt: {
          gte: start,
          lt: end
        }
      }
    });

    if (duplicate) {
      throw new ApiError(409, "Bu görüşme tarihi zaten kayıtlı.");
    }

    const customer = await prisma.$transaction(async (tx) => {
      await tx.customerContact.create({
        data: {
          customerId: id,
          contactedAt: parsed.contactedAt,
          note: parsed.note ?? null,
          actorSub: actor.sub,
          actorEmail: actor.email,
          actorName: actor.name
        }
      });

      const metrics = await contactMetrics(tx, id, existing.callCount + 1);
      const updated = await tx.customer.update({
        where: { id },
        data: {
          ...metrics,
          ...(parsed.note ? { contactDetail: parsed.note } : {}),
          ...actorFields(actor, "update")
        }
      });

      await tx.activityLog.create({
        data: {
          customerId: id,
          action: "UPDATE",
          summary: `${updated.companyName} için görüşme tarihi eklendi.`,
          changes: {
            lastContactedAt: {
              before: existing.lastContactedAt?.toISOString() ?? null,
              after: metrics.lastContactedAt?.toISOString() ?? null
            },
            callCount: {
              before: existing.callCount,
              after: metrics.callCount
            }
          },
          actorSub: actor.sub,
          actorEmail: actor.email,
          actorName: actor.name
        }
      });

      return tx.customer.findUniqueOrThrow({
        where: { id: updated.id },
        include: customerContactInclude
      });
    });

    return Response.json({ customer: serializeCustomer(customer) }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
