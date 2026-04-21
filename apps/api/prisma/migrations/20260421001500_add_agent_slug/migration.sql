-- AlterTable
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "slug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Agent_slug_key" ON "Agent"("slug");
