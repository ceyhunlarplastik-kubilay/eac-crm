import { customerCreateSchema } from "@/lib/customer-schema";
import { resolveCustomerCategory } from "@/lib/category-service";
import { requireCustomerWrites } from "@/lib/category-transition";
import {
  actorFields,
  customerContactInclude,
  serializeCustomer
} from "@/lib/customer-service";
import { buildCustomerWhere, readPagination } from "@/lib/customer-filters";
import { prisma } from "@/lib/prisma";
import { jsonError, requireAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdmin();

    const url = new URL(request.url);
    const where = buildCustomerWhere(url.searchParams);
    const { page, pageSize, skip } = readPagination(url.searchParams);

    const [total, customers] = await Promise.all([
      prisma.customer.count({ where }),
      prisma.customer.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { sequenceNumber: "asc" }],
        skip,
        take: pageSize,
        include: customerContactInclude
      })
    ]);

    return Response.json({
      customers: customers.map(serializeCustomer),
      pagination: {
        page,
        pageSize,
        total,
        pageCount: Math.max(Math.ceil(total / pageSize), 1)
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { actor } = await requireAdmin();
    requireCustomerWrites();
    const parsed = customerCreateSchema.parse(await request.json());

    const existing = await prisma.customer.findUnique({
      where: { dedupeKey: parsed.dedupeKey }
    });

    if (existing && !existing.deletedAt) {
      return Response.json(
        { error: "Bu firma aynı iletişim bilgileriyle zaten kayıtlı." },
        { status: 409 }
      );
    }

    const customer = await prisma.$transaction(async (tx) => {
      const data = {
        ...parsed,
        ...await resolveCustomerCategory(tx, parsed),
        callCount: parsed.lastContactedAt
          ? Math.max(parsed.callCount ?? 0, 1)
          : parsed.callCount
      };

      const saved = existing
        ? await tx.customer.update({
            where: { id: existing.id },
            data: {
              ...data,
              deletedAt: null,
              ...actorFields(actor, "update")
            },
            include: customerContactInclude
          })
        : await tx.customer.create({
            data: {
              ...data,
              ...actorFields(actor, "create")
            },
            include: customerContactInclude
          });

      if (data.lastContactedAt) {
        await tx.customerContact.create({
          data: {
            customerId: saved.id,
            contactedAt: data.lastContactedAt,
            note: data.contactDetail,
            actorSub: actor.sub,
            actorEmail: actor.email,
            actorName: actor.name
          }
        });
      }

      await tx.activityLog.create({
        data: {
          customerId: saved.id,
          action: "CREATE",
          summary: `${saved.companyName} kaydı oluşturuldu.`,
          changes: JSON.parse(JSON.stringify({ ...data, category: saved.category?.name ?? null })),
          actorSub: actor.sub,
          actorEmail: actor.email,
          actorName: actor.name
        }
      });

      return tx.customer.findUniqueOrThrow({
        where: { id: saved.id },
        include: customerContactInclude
      });
    });

    return Response.json({ customer: serializeCustomer(customer) }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
