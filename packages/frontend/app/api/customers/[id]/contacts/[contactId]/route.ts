import {
  actorFields,
  contactMetrics,
  customerContactInclude,
  serializeCustomer
} from "@/lib/customer-service";
import { requireCustomerWrites } from "@/lib/category-transition";
import { prisma } from "@/lib/prisma";
import { ApiError, jsonError, requireAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string; contactId: string }>;
};

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { actor } = await requireAdmin();
    requireCustomerWrites();
    const { id, contactId } = await context.params;

    const customer = await prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: { id, deletedAt: null }
      });

      if (!existing) {
        throw new ApiError(404, "Müşteri bulunamadı.");
      }

      const contact = await tx.customerContact.findFirst({
        where: { id: contactId, customerId: id }
      });

      if (!contact) {
        throw new ApiError(404, "Görüşme tarihi bulunamadı.");
      }

      await tx.customerContact.delete({
        where: { id: contact.id }
      });

      const metrics = await contactMetrics(
        tx,
        id,
        Math.max(existing.callCount - 1, 0)
      );
      const updated = await tx.customer.update({
        where: { id },
        data: {
          ...metrics,
          ...actorFields(actor, "update")
        }
      });

      await tx.activityLog.create({
        data: {
          customerId: id,
          action: "UPDATE",
          summary: `${updated.companyName} için görüşme tarihi silindi.`,
          changes: {
            deletedContactedAt: contact.contactedAt.toISOString(),
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

    return Response.json({ customer: serializeCustomer(customer) });
  } catch (error) {
    return jsonError(error);
  }
}
