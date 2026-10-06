-- Expand only: keep Customer.category and its index until the contract release.
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT COLLATE "C" NOT NULL,
    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");
ALTER TABLE "Customer" ADD COLUMN "categoryId" TEXT;
CREATE INDEX "Customer_categoryId_idx" ON "Customer"("categoryId");
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
