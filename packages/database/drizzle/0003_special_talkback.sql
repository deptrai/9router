ALTER TABLE "ledger_transactions" ALTER COLUMN "type" SET DATA TYPE varchar(30);--> statement-breakpoint
ALTER TABLE "ledger_transactions" ALTER COLUMN "reference_id" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "ledger_transactions" ALTER COLUMN "idempotency_key" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD COLUMN "metadata" jsonb;