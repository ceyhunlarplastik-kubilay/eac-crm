import ExcelJS from "exceljs";
import { buildCustomerWhere } from "@/lib/customer-filters";
import { prisma } from "@/lib/prisma";
import { jsonError, requireAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const dateFieldLabels: Record<string, string> = {
  lastContactedAt: "Görüşme tarihi",
  updatedAt: "Son işlem",
  createdAt: "Oluşturma",
  shipmentDate: "Gönderim tarihi"
};

const reachLabels: Record<string, string> = {
  REACHED: "Ulaşıldı",
  NOT_REACHED: "Ulaşılamadı",
  UNKNOWN: "Belirsiz"
};

const interestLabels: Record<string, string> = {
  INTERESTED: "İlgilendi",
  NOT_INTERESTED: "İlgilenmedi",
  UNKNOWN: "Belirsiz"
};

const sampleLabels: Record<string, string> = {
  WILL_SEND: "Gönderilecek",
  WILL_NOT_SEND: "Gönderilmeyecek",
  SENT: "Gönderildi",
  UNKNOWN: "Belirsiz"
};

function parseDate(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateTime(value: Date | string | null | undefined) {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Istanbul"
  }).format(date);
}

function boolLabel(value: boolean | null) {
  if (value === true) return "Evet";
  if (value === false) return "Hayır";
  return "Belirsiz";
}

function searchParamLabel(value: string | null) {
  return value && value !== "all" ? value : "Tümü";
}

function fitColumns(worksheet: ExcelJS.Worksheet) {
  worksheet.columns.forEach((column) => {
    let maxLength = 10;
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      const value = cell.value;
      const text =
        value instanceof Date
          ? formatDateTime(value)
          : typeof value === "object" && value !== null
            ? JSON.stringify(value)
            : String(value ?? "");
      maxLength = Math.max(maxLength, text.length);
    });
    column.width = Math.min(Math.max(maxLength + 2, 10), 42);
  });
}

function addHeaderStyle(worksheet: ExcelJS.Worksheet, rowNumber = 1) {
  const row = worksheet.getRow(rowNumber);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF0F766E" }
  };
}

export async function GET(request: Request) {
  try {
    await requireAdmin();

    const url = new URL(request.url);
    const where = buildCustomerWhere(url.searchParams);
    const activityStart = parseDate(url.searchParams.get("start"));
    const activityEnd = parseDate(url.searchParams.get("end"));

    const customers = await prisma.customer.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { sequenceNumber: "asc" }],
      include: {
        contacts: {
          orderBy: [{ contactedAt: "desc" }, { createdAt: "desc" }],
          take: 2
        }
      }
    });

    const customerIds = customers.map((customer) => customer.id);
    const activities =
      activityStart && activityEnd && customerIds.length
        ? await prisma.activityLog.findMany({
            where: {
              createdAt: {
                gte: activityStart,
                lte: activityEnd
              },
              ...(customerIds.length ? { customerId: { in: customerIds } } : {})
            },
            orderBy: { createdAt: "desc" },
            take: 500
          })
        : [];

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "EAPARAT CRM";
    workbook.created = new Date();

    const summary = workbook.addWorksheet("Özet");
    summary.addRows([
      ["EAPARAT CRM Raporu", ""],
      ["Rapor zamanı", formatDateTime(new Date())],
      ["", ""],
      ["Filtre", "Değer"],
      ["Arama", searchParamLabel(url.searchParams.get("q"))],
      ["Şehir", searchParamLabel(url.searchParams.get("city"))],
      ["Kategori", searchParamLabel(url.searchParams.get("category"))],
      ["Ulaşıldı", searchParamLabel(url.searchParams.get("reached"))],
      ["Durum", searchParamLabel(url.searchParams.get("interestStatus"))],
      ["Numune", searchParamLabel(url.searchParams.get("sampleStatus"))],
      ["Tarih alanı", dateFieldLabels[url.searchParams.get("dateField") ?? ""] ?? "Görüşme tarihi"],
      ["Başlangıç", url.searchParams.get("dateFrom") ?? "-"],
      ["Bitiş", url.searchParams.get("dateTo") ?? "-"],
      ["Görüşme min", url.searchParams.get("callCountMin") ?? "-"],
      ["Görüşme max", url.searchParams.get("callCountMax") ?? "-"],
      ["", ""],
      ["İstatistik", "Adet"],
      ["Toplam müşteri", customers.length],
      ["Ulaşıldı", customers.filter((customer) => customer.reached === "REACHED").length],
      [
        "Ulaşılamadı",
        customers.filter((customer) => customer.reached === "NOT_REACHED").length
      ],
      ["İlgilendi", customers.filter((customer) => customer.interestStatus === "INTERESTED").length],
      [
        "İlgilenmedi",
        customers.filter((customer) => customer.interestStatus === "NOT_INTERESTED").length
      ],
      ["Katalog gönderildi", customers.filter((customer) => customer.catalogSent === true).length],
      [
        "Numune gönderilecek",
        customers.filter((customer) => customer.sampleStatus === "WILL_SEND").length
      ],
      ["Numune gönderildi", customers.filter((customer) => customer.sampleStatus === "SENT").length],
      [
        "Toplam görüşme sayısı",
        customers.reduce((total, customer) => total + customer.callCount, 0)
      ],
      ["İşlem logu", activities.length],
      ["İşlem yapılan müşteri", new Set(activities.map((activity) => activity.customerId).filter(Boolean)).size],
      ["İşlem aralığı başlangıç", activityStart ? formatDateTime(activityStart) : "-"],
      ["İşlem aralığı bitiş", activityEnd ? formatDateTime(activityEnd) : "-"]
    ]);
    summary.mergeCells("A1:B1");
    summary.getCell("A1").font = { bold: true, size: 16 };
    addHeaderStyle(summary, 4);
    addHeaderStyle(summary, 17);
    fitColumns(summary);

    const customerSheet = workbook.addWorksheet("Müşteriler");
    customerSheet.addRow([
      "Sıra",
      "Firma",
      "Şehir",
      "Yetkili",
      "Telefon",
      "Email",
      "Ulaşıldı",
      "Görüşme Sayısı",
      "Son Görüşme 1",
      "Son Görüşme 2",
      "İlgilenme",
      "Katalog",
      "Uygun Ürün",
      "Cari Bilgi",
      "Numune",
      "Gönderim Tarihi",
      "Son İşlem",
      "Görüşme Detayı"
    ]);
    addHeaderStyle(customerSheet);

    customers.forEach((customer, index) => {
      const contactDates = customer.contacts.map((contact) => contact.contactedAt);
      customerSheet.addRow([
        index + 1,
        customer.companyName,
        customer.city ?? "",
        customer.contactName ?? "",
        customer.phone ?? customer.mobilePhone ?? "",
        customer.email ?? "",
        reachLabels[customer.reached],
        customer.callCount,
        formatDateTime(contactDates[0] ?? customer.lastContactedAt),
        formatDateTime(contactDates[1]),
        interestLabels[customer.interestStatus],
        boolLabel(customer.catalogSent),
        boolLabel(customer.hasSuitableProductGroup),
        boolLabel(customer.currentAccountInfoReceived),
        sampleLabels[customer.sampleStatus],
        formatDateTime(customer.shipmentDate),
        formatDateTime(customer.updatedAt),
        customer.contactDetail ?? ""
      ]);
    });
    customerSheet.views = [{ state: "frozen", ySplit: 1 }];
    customerSheet.autoFilter = {
      from: "A1",
      to: "R1"
    };
    fitColumns(customerSheet);

    const activitySheet = workbook.addWorksheet("Son İşlemler");
    activitySheet.addRow(["Tarih", "İşlem", "Özet", "Kullanıcı"]);
    addHeaderStyle(activitySheet);
    activities.forEach((activity) => {
      activitySheet.addRow([
        formatDateTime(activity.createdAt),
        activity.action,
        activity.summary,
        activity.actorName ?? activity.actorEmail ?? ""
      ]);
    });
    activitySheet.views = [{ state: "frozen", ySplit: 1 }];
    fitColumns(activitySheet);

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `eaparat-crm-rapor-${new Date().toISOString().slice(0, 10)}.xlsx`;

    return new Response(buffer, {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${filename}"`
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
