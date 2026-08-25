import { customerUpdateSchema } from "@/lib/customer-schema";
import {
  actorFields,
  customerContactInclude,
  diffCustomer,
  rebuildDedupeKey,
  serializeCustomer,
  writeActivity
} from "@/lib/customer-service";
import { normalizeSampleStatus } from "@/lib/customer-rules";
import { prisma } from "@/lib/prisma";
import { ApiError, jsonError, requireAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function dateKey(value: Date | null | undefined) {
  return value instanceof Date ? value.toISOString() : null;
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { actor } = await requireAdmin();
    const { id } = await context.params;
    const parsed = customerUpdateSchema.parse(await request.json());

    const existing = await prisma.customer.findFirst({
      where: { id, deletedAt: null }
    });

    if (!existing) {
      throw new ApiError(404, "Müşteri bulunamadı.");
    }

    const patch = normalizeSampleStatus(parsed, existing);
    const nextContactedAt =
      patch.lastContactedAt instanceof Date ? patch.lastContactedAt : null;
    const shouldRecordContact =
      "lastContactedAt" in patch &&
      nextContactedAt !== null &&
      dateKey(existing.lastContactedAt) !== dateKey(nextContactedAt);

    if (shouldRecordContact) {
      patch.callCount =
        Math.max(existing.callCount, patch.callCount ?? existing.callCount) + 1;
    }

    const data: typeof patch & { dedupeKey?: string } =
      "companyName" in patch || "city" in patch || "phone" in patch || "email" in patch
        ? { ...patch, dedupeKey: rebuildDedupeKey(existing, patch) }
        : patch;

    if (data.dedupeKey) {
      const duplicate = await prisma.customer.findUnique({
        where: { dedupeKey: data.dedupeKey }
      });

      if (duplicate && duplicate.id !== id && !duplicate.deletedAt) {
        return Response.json(
          { error: "Bu firma aynı iletişim bilgileriyle zaten kayıtlı." },
          { status: 409 }
        );
      }
    }

    const changes = diffCustomer(existing, data);

    const customer = await prisma.$transaction(async (tx) => {
      const saved = await tx.customer.update({
        where: { id },
        data: {
          ...data,
          ...actorFields(actor, "update")
        }
      });

      if (shouldRecordContact && nextContactedAt) {
        await tx.customerContact.create({
          data: {
            customerId: id,
            contactedAt: nextContactedAt,
            note: data.contactDetail,
            actorSub: actor.sub,
            actorEmail: actor.email,
            actorName: actor.name
          }
        });
      }

      return tx.customer.findUniqueOrThrow({
        where: { id: saved.id },
        include: customerContactInclude
      });
    });

    await writeActivity({
      customerId: customer.id,
      action: "UPDATE",
      summary: `${customer.companyName} kaydı güncellendi.`,
      changes,
      actor
    });

    return Response.json({ customer: serializeCustomer(customer) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { actor } = await requireAdmin();
    const { id } = await context.params;

    const existing = await prisma.customer.findFirst({
      where: { id, deletedAt: null }
    });

    if (!existing) {
      throw new ApiError(404, "Müşteri bulunamadı.");
    }

    const customer = await prisma.customer.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        ...actorFields(actor, "update")
      }
    });

    await writeActivity({
      customerId: customer.id,
      action: "DELETE",
      summary: `${customer.companyName} kaydı silindi.`,
      actor
    });

    return Response.json({ customer: serializeCustomer(customer) });
  } catch (error) {
    return jsonError(error);
  }
}
