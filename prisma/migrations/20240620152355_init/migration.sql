/*
  Warnings:

  - You are about to drop the column `totalSent` on the `Account` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Account" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "messageId" INTEGER,
    "waitLink" BOOLEAN NOT NULL DEFAULT false,
    "link" TEXT,
    "testMail" TEXT
);
INSERT INTO "new_Account" ("id") SELECT "id" FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
CREATE UNIQUE INDEX "Account_messageId_key" ON "Account"("messageId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
