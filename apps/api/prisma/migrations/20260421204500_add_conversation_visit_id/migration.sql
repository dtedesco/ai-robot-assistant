-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "visitId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Conversation_visitId_idx" ON "Conversation"("visitId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Conversation_visitId_fkey'
  ) THEN
    ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_visitId_fkey"
    FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
