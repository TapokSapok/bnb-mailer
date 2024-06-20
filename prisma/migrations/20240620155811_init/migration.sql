/*
  Warnings:

  - The primary key for the `Account` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" INTEGER,
    "waitLink" BOOLEAN NOT NULL DEFAULT false,
    "link" TEXT,
    "testMail" TEXT
);
INSERT INTO "new_Account" ("id", "link", "messageId", "testMail", "waitLink") SELECT "id", "link", "messageId", "testMail", "waitLink" FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
CREATE UNIQUE INDEX "Account_id_key" ON "Account"("id");
CREATE UNIQUE INDEX "Account_messageId_key" ON "Account"("messageId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
