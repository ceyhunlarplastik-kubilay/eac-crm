import ExcelJS from "exceljs";
import { customerCreateSchema, type CustomerCreateInput } from "@/lib/customer-schema";
import { normalizeText } from "@/lib/utils";

const columnMap: Record<string, keyof CustomerCreateInput> = {
  "Sıra Numarası": "sequenceNumber",
  Firma: "companyName",
  "Web Adresi": "website",
  Email: "email",
  Telefon: "phone",
  "Şehir": "city",
  Kategori: "category",
  Yetkili: "contactName",
  "Cep Numarası": "mobilePhone",
  "Ulaşıldı": "reached",
  "Görüşme Sayısı": "callCount",
  "Görüşme Tarihi": "lastContactedAt",
  "Görüşme Detayı": "contactDetail",
  "İlgilenme Durumu": "interestStatus",
  "Katalog Gönderildi": "catalogSent",
  "Uygun Ürün Gurubu Var Mı?": "hasSuitableProductGroup",
  "Cari Bilgisi Geldi": "currentAccountInfoReceived",
  "Numune Gönderilecek Mi?": "sampleStatus",
  "Gönderim Tarihi": "shipmentDate"
};

const defaultImportHour = 11;

function padDatePart(value: number) {
  return value.toString().padStart(2, "0");
}

function localDateTime(year: number, month: number, day: number, hour = defaultImportHour, minute = 0) {
  return new Date(
    `${year}-${padDatePart(month)}-${padDatePart(day)}T${padDatePart(hour)}:${padDatePart(
      minute
    )}:00.000+03:00`
  );
}

function validLocalDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

function normalizeHeader(value: unknown) {
  return normalizeText(value)?.toLocaleLowerCase("tr-TR") ?? "";
}

function readCellValue(cell: ExcelJS.Cell) {
  const value = cell.value;

  if (value instanceof Date) return value;
  if (typeof value === "object" && value && "text" in value) {
    return normalizeText((value as { text?: string }).text);
  }
  if (typeof value === "object" && value && "result" in value) {
    return (value as { result?: unknown }).result;
  }
  if (typeof value === "number") return value;

  return normalizeText(cell.text || value);
}

function yesNoToBoolean(value: unknown) {
  const normalized = normalizeText(value)?.toLocaleLowerCase("tr-TR");
  if (!normalized) return null;
  if (normalized === "evet") return true;
  if (normalized === "hayır" || normalized === "hayir") return false;
  return null;
}

function mapReachStatus(value: unknown) {
  const normalized = normalizeText(value)?.toLocaleLowerCase("tr-TR");
  if (normalized === "evet") return "REACHED";
  if (normalized === "hayır" || normalized === "hayir") return "NOT_REACHED";
  return "UNKNOWN";
}

function mapInterestStatus(value: unknown) {
  const normalized = normalizeText(value)?.toLocaleLowerCase("tr-TR");
  if (normalized === "ilgilendi") return "INTERESTED";
  if (!normalized) return "UNKNOWN";
  return "NOT_INTERESTED";
}

function mapSampleStatus(value: unknown) {
  const normalized = normalizeText(value)?.toLocaleLowerCase("tr-TR");
  if (normalized === "gönderildi") return "SENT";
  if (normalized === "gönderilecek") return "WILL_SEND";
  if (normalized === "gönderilmeyecek") return "WILL_NOT_SEND";
  return "UNKNOWN";
}

function excelSerialDate(value: number) {
  const utcDays = Math.floor(value - 25569);
  const utcValue = utcDays * 86400;
  const date = new Date(utcValue * 1000);
  return localDateTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function parseDateText(value: unknown) {
  if (value instanceof Date) {
    return localDateTime(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }

  if (typeof value === "number" && value > 0) return excelSerialDate(value);

  const normalized = normalizeText(value);
  if (!normalized) return null;

  const turkishDate = normalized.match(
    /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})(?:\s+(\d{1,2})(?::(\d{2}))?)?$/
  );

  if (turkishDate) {
    const day = Number.parseInt(turkishDate[1] ?? "", 10);
    const month = Number.parseInt(turkishDate[2] ?? "", 10);
    const rawYear = Number.parseInt(turkishDate[3] ?? "", 10);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const hour = Number.parseInt(turkishDate[4] ?? String(defaultImportHour), 10);
    const minute = Number.parseInt(turkishDate[5] ?? "0", 10);

    if (validLocalDate(year, month, day)) {
      return localDateTime(year, month, day, hour, minute);
    }
  }

  const isoDate = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2}))?/);

  if (isoDate) {
    const year = Number.parseInt(isoDate[1] ?? "", 10);
    const month = Number.parseInt(isoDate[2] ?? "", 10);
    const day = Number.parseInt(isoDate[3] ?? "", 10);
    const hour = Number.parseInt(isoDate[4] ?? String(defaultImportHour), 10);
    const minute = Number.parseInt(isoDate[5] ?? "0", 10);

    if (validLocalDate(year, month, day)) {
      return localDateTime(year, month, day, hour, minute);
    }
  }

  return normalized;
}

function mapValue(field: keyof CustomerCreateInput, value: unknown) {
  if (
    field === "catalogSent" ||
    field === "hasSuitableProductGroup" ||
    field === "currentAccountInfoReceived"
  ) {
    return yesNoToBoolean(value);
  }

  if (field === "reached") return mapReachStatus(value);
  if (field === "interestStatus") return mapInterestStatus(value);
  if (field === "sampleStatus") return mapSampleStatus(value);

  if (field === "lastContactedAt" || field === "shipmentDate") {
    return parseDateText(value);
  }

  if (field === "sequenceNumber" || field === "callCount" || field === "sourceRowNumber") {
    if (typeof value === "number") return value;
    const parsed = Number.parseInt(normalizeText(value) ?? "", 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return normalizeText(value);
}

export async function parseCustomerWorkbook(file: File) {
  const workbook = new ExcelJS.Workbook();
  const buffer = await file.arrayBuffer();
  await workbook.xlsx.load(buffer);

  const worksheet = workbook.worksheets[0];

  if (!worksheet) {
    throw new Error("Excel dosyasında okunabilir sayfa bulunamadı.");
  }

  let headerRowNumber = 0;
  const headerColumns = new Map<number, keyof CustomerCreateInput>();

  worksheet.eachRow((row, rowNumber) => {
    if (headerRowNumber) return;

    row.eachCell((cell, colNumber) => {
      const header = normalizeHeader(readCellValue(cell));
      const canonicalHeader = Object.keys(columnMap).find(
        (key) => normalizeHeader(key) === header
      );

      if (canonicalHeader) {
        headerColumns.set(colNumber, columnMap[canonicalHeader]);
      }
    });

    if ([...headerColumns.values()].includes("companyName")) {
      headerRowNumber = rowNumber;
    } else {
      headerColumns.clear();
    }
  });

  if (!headerRowNumber) {
    throw new Error("Excel başlık satırı bulunamadı.");
  }

  const rows: CustomerCreateInput[] = [];
  const skipped: Array<{ rowNumber: number; reason: string }> = [];

  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const raw: Record<string, unknown> = {
      sourceRowNumber: rowNumber
    };

    for (const [colNumber, field] of headerColumns) {
      raw[field] = mapValue(field, readCellValue(row.getCell(colNumber)));
    }

    if (!normalizeText(raw.companyName)) {
      skipped.push({ rowNumber, reason: "Firma adı boş" });
      continue;
    }

    const parsed = customerCreateSchema.safeParse(raw);

    if (parsed.success) {
      rows.push(parsed.data);
    } else {
      skipped.push({
        rowNumber,
        reason: parsed.error.issues.map((issue) => issue.message).join(", ")
      });
    }
  }

  return {
    rows,
    skipped,
    totalRows: rows.length + skipped.length
  };
}
