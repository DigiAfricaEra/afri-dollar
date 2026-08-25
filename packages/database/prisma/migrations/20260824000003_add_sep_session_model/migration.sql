-- CreateTable
CREATE TABLE "SEPSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" TEXT,
    "stellarTxId" TEXT,
    "externalRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'incomplete',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SEPSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SEPSession_stellarTxId_key" ON "SEPSession"("stellarTxId");

-- CreateIndex
CREATE INDEX "SEPSession_userId_idx" ON "SEPSession"("userId");

-- CreateIndex
CREATE INDEX "SEPSession_status_idx" ON "SEPSession"("status");

-- CreateIndex
CREATE INDEX "SEPSession_stellarTxId_idx" ON "SEPSession"("stellarTxId");

-- CreateIndex
CREATE INDEX "SEPSession_type_status_idx" ON "SEPSession"("type", "status");

-- AddForeignKey
ALTER TABLE "SEPSession" ADD CONSTRAINT "SEPSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "SEPWatchCursor" (
    "id" TEXT NOT NULL,
    "pagingToken" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SEPWatchCursor_pkey" PRIMARY KEY ("id")
);
